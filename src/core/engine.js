'use strict';
/**
 * engine.js — orchestrates scan and repair over a set of projects.
 *
 * Scanning is strictly read-only. Repair writes only to the output tree, and
 * only after a file has passed every validation step.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { decompressMmpz } = require('./mmpz');
const { decodeProjectText, encodeProjectText, validateProjectText } = require('./mmp');
const { replacePathRoot, buildVariants, extractExample } = require('./pathReplace');
const validator = require('./validator');
const { scanTree } = require('./scanner');

const STATUS = {
  WILL_MODIFY: 'WILL MODIFY',
  NO_MATCH: 'NO MATCH',
  INVALID_MMPZ: 'INVALID MMPZ',
  DECOMPRESSION_FAILED: 'DECOMPRESSION FAILED',
  INVALID_PROJECT: 'INVALID PROJECT',
  ERROR: 'ERROR',
  MODIFIED: 'MODIFIED',
  SKIPPED: 'SKIPPED',
  VALIDATION_FAILED: 'VALIDATION FAILED',
};

/**
 * Read a project file and return its XML text, whatever the container.
 * @param {{absolutePath: string, format: string}} project
 */
async function readProjectText(project) {
  const raw = await fsp.readFile(project.absolutePath);

  if (project.format === 'mmpz') {
    if (raw.length < 5) {
      return { error: STATUS.INVALID_MMPZ, message: 'file is too short to be a .mmpz' };
    }
    let xmlBytes;
    try {
      xmlBytes = decompressMmpz(raw);
    } catch (err) {
      const status =
        err.code === 'TOO_SHORT' || err.code === 'DECLARED_SIZE_TOO_LARGE'
          ? STATUS.INVALID_MMPZ
          : STATUS.DECOMPRESSION_FAILED;
      return { error: status, message: err.message };
    }
    try {
      const { text, hadBom } = decodeProjectText(xmlBytes);
      return { text, hadBom, sourceBytes: raw, xmlBytes };
    } catch (err) {
      return { error: STATUS.INVALID_PROJECT, message: err.message };
    }
  }

  try {
    const { text, hadBom } = decodeProjectText(raw);
    return { text, hadBom, sourceBytes: raw, xmlBytes: raw };
  } catch (err) {
    return { error: STATUS.INVALID_PROJECT, message: err.message };
  }
}

/**
 * Dry-run scan. Never modifies anything.
 *
 * @param {string} root
 * @param {{oldPath: string, newPath: string, matchSeparatorVariants?: boolean}} settings
 * @param {{onProgress?: Function, limits?: object}} [hooks]
 */
async function scan(root, settings, hooks = {}) {
  const { projects, stats } = await scanTree(root, hooks.limits);
  const results = [];

  let projectsWithMatches = 0;
  let totalOccurrences = 0;
  /** One real path from the user's own projects, for the preview. */
  let example = null;

  for (let i = 0; i < projects.length; i += 1) {
    const project = projects[i];
    const entry = {
      file: project.relativePath,
      absolutePath: project.absolutePath,
      format: project.format,
      occurrences: 0,
      oldPath: settings.oldPath,
      newPath: settings.newPath,
      status: STATUS.NO_MATCH,
      byVariant: {},
    };

    const loaded = await readProjectText(project);
    if (loaded.error) {
      entry.status = loaded.error;
      entry.message = loaded.message;
      results.push(entry);
      continue;
    }

    const validation = validateProjectText(loaded.text);
    if (!validation.valid) {
      entry.status = STATUS.INVALID_PROJECT;
      entry.message = validation.reason;
      results.push(entry);
      continue;
    }

    try {
      const { occurrences, byVariant } = replacePathRoot(
        loaded.text,
        settings.oldPath,
        settings.newPath,
        { matchSeparatorVariants: settings.matchSeparatorVariants }
      );
      entry.occurrences = occurrences;
      entry.byVariant = byVariant;
      entry.status = occurrences > 0 ? STATUS.WILL_MODIFY : STATUS.NO_MATCH;
      if (occurrences > 0) {
        projectsWithMatches += 1;
        totalOccurrences += occurrences;
        if (!example) {
          example = extractExample(
            loaded.text,
            buildVariants(settings.oldPath, settings.newPath, {
              matchSeparatorVariants: settings.matchSeparatorVariants,
            })
          );
        }
      }
    } catch (err) {
      entry.status = STATUS.ERROR;
      entry.message = err.message;
    }

    results.push(entry);

    if (hooks.onProgress && i % 25 === 0) {
      hooks.onProgress({ done: i + 1, total: projects.length });
    }
  }

  return {
    results,
    summary: {
      foldersScanned: stats.foldersScanned,
      mmpFound: stats.mmpCount,
      mmpzFound: stats.mmpzCount,
      projectsFound: projects.length,
      projectsWithMatches,
      projectsWithoutMatches: projects.length - projectsWithMatches,
      totalOccurrences,
      example,
      skippedSymlinks: stats.skippedSymlinks,
      skippedTooLarge: stats.skippedTooLarge,
    },
  };
}

/**
 * Repair a single already-loaded project, returning the bytes to write.
 * Performs the full validation chain before returning anything.
 */
function repairBytes(loaded, settings) {
  const variants = buildVariants(settings.oldPath, settings.newPath, {
    matchSeparatorVariants: settings.matchSeparatorVariants,
  });

  const replaced = replacePathRoot(loaded.text, settings.oldPath, settings.newPath, {
    matchSeparatorVariants: settings.matchSeparatorVariants,
  });

  if (replaced.occurrences === 0) {
    return { occurrences: 0, unchanged: true };
  }

  const stillValid = validator.verifyStillValidProject(replaced.text);
  if (!stillValid.ok) {
    return { error: STATUS.VALIDATION_FAILED, message: stillValid.reason };
  }

  const delta = validator.verifyDeltaConsistent(
    loaded.text,
    replaced.text,
    replaced.occurrences,
    variants,
    replaced.byVariant
  );
  if (!delta.ok) {
    return { error: STATUS.VALIDATION_FAILED, message: delta.reason };
  }

  const modifiedXmlBytes = encodeProjectText(replaced.text, loaded.hadBom);

  return {
    occurrences: replaced.occurrences,
    byVariant: replaced.byVariant,
    modifiedXmlBytes,
  };
}

/**
 * Execute the repair, writing a parallel output tree.
 *
 * @param {string} root source folder / file
 * @param {string} outputRoot destination folder
 * @param {object} settings
 * @param {object} [hooks]
 */
async function repair(root, outputRoot, settings, hooks = {}) {
  const { projects, stats } = await scanTree(root, hooks.limits);
  const rootStat = await fsp.lstat(root);
  const isSingleFile = rootStat.isFile();

  const records = [];
  const summary = {
    projectsProcessed: 0,
    projectsModified: 0,
    replacements: 0,
    projectsSkipped: 0,
    validationFailures: 0,
    outputLocation: outputRoot,
  };

  for (let i = 0; i < projects.length; i += 1) {
    const project = projects[i];
    summary.projectsProcessed += 1;

    const record = {
      filename: project.relativePath,
      format: project.format,
      oldPath: settings.oldPath,
      newPath: settings.newPath,
      occurrences: 0,
      decompression: project.format === 'mmpz' ? 'pending' : 'n/a',
      recompression: project.format === 'mmpz' ? 'pending' : 'n/a',
      roundTrip: 'n/a',
      result: STATUS.SKIPPED,
    };

    try {
      const loaded = await readProjectText(project);
      if (loaded.error) {
        record.result = loaded.error;
        record.message = loaded.message;
        if (project.format === 'mmpz') record.decompression = 'failed';
        summary.validationFailures += 1;
        records.push(record);
        continue;
      }
      if (project.format === 'mmpz') record.decompression = 'ok';

      const validation = validateProjectText(loaded.text);
      if (!validation.valid) {
        record.result = STATUS.INVALID_PROJECT;
        record.message = validation.reason;
        summary.validationFailures += 1;
        records.push(record);
        continue;
      }

      const repaired = repairBytes(loaded, settings);

      if (repaired.error) {
        record.result = repaired.error;
        record.message = repaired.message;
        summary.validationFailures += 1;
        records.push(record);
        continue;
      }

      if (repaired.unchanged) {
        record.result = STATUS.NO_MATCH;
        summary.projectsSkipped += 1;
        // Unmodified projects are still copied so the output tree is complete.
        if (!settings.onlyWriteModified) {
          await copyThrough(project, root, outputRoot, isSingleFile, settings);
        }
        records.push(record);
        continue;
      }

      record.occurrences = repaired.occurrences;
      record.byVariant = repaired.byVariant;

      let outputBytes;
      if (project.format === 'mmpz') {
        const compressed = validator.compressVerified(repaired.modifiedXmlBytes);
        if (!compressed.ok) {
          record.recompression = 'failed';
          record.roundTrip = 'failed';
          record.result = STATUS.VALIDATION_FAILED;
          record.message = compressed.reason;
          summary.validationFailures += 1;
          records.push(record);
          continue;
        }
        record.recompression = 'ok';
        record.roundTrip = 'ok';
        record.sha256Xml = compressed.expectedSha;
        outputBytes = compressed.buffer;
      } else {
        outputBytes = repaired.modifiedXmlBytes;
        record.roundTrip = 'ok';
        record.sha256Xml = validator.sha256(outputBytes);
      }

      const destination = await resolveDestination(
        project,
        root,
        outputRoot,
        isSingleFile,
        settings
      );
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, outputBytes);
      await preserveTimes(project.absolutePath, destination);

      record.outputPath = destination;
      record.result = STATUS.MODIFIED;
      summary.projectsModified += 1;
      summary.replacements += repaired.occurrences;
    } catch (err) {
      record.result = STATUS.ERROR;
      record.message = err.message;
      summary.validationFailures += 1;
    }

    records.push(record);

    if (hooks.onProgress) {
      hooks.onProgress({ done: i + 1, total: projects.length });
    }
  }

  return { records, summary, stats };
}

/**
 * Work out where a repaired project should be written, keeping the output
 * strictly inside `outputRoot`.
 */
async function resolveDestination(project, root, outputRoot, isSingleFile, settings) {
  if (isSingleFile) {
    const ext = path.extname(project.absolutePath);
    const base = path.basename(project.absolutePath, ext);
    const suffix = settings.replaceOriginals ? '' : '_RELINKED';
    return path.join(outputRoot, `${base}${suffix}${ext}`);
  }

  const destination = path.resolve(outputRoot, project.relativePath);
  assertInside(outputRoot, destination);
  return destination;
}

/** Copy a project through to the output tree unchanged. */
async function copyThrough(project, root, outputRoot, isSingleFile, settings) {
  const destination = await resolveDestination(
    project,
    root,
    outputRoot,
    isSingleFile,
    settings
  );
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(project.absolutePath, destination);
  await preserveTimes(project.absolutePath, destination);
}

/**
 * Copy the source file's modification time onto the output file.
 *
 * Users sort their project libraries by date, so a bulk repair that restamped
 * every file with "now" would scramble months of history. We write real files
 * (never symlinks, which cannot hold repaired content and break when moved) and
 * then restore the timestamps.
 *
 * Note: only mtime and atime can be set portably. A file's creation date is
 * assigned by the OS on write and is not settable through Node, so the output
 * will carry a fresh creation date on platforms that track one.
 */
async function preserveTimes(sourcePath, destinationPath) {
  try {
    const stat = await fsp.stat(sourcePath);
    await fsp.utimes(destinationPath, stat.atime, stat.mtime);
  } catch {
    // Never fail a repair because a timestamp could not be restored.
  }
}

/** Refuse any destination that escapes the chosen output directory. */
function assertInside(baseDir, candidate) {
  const base = path.resolve(baseDir);
  const target = path.resolve(candidate);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside the output folder: ${candidate}`);
  }
  return target;
}

/**
 * Copy an entire tree to `dest`, preserving unrelated files and the hierarchy.
 *
 * Repair then writes repaired projects over their copies inside `dest`, which
 * keeps the source tree read-only while still producing a complete output tree
 * containing the user's samples, artwork and anything else that was there.
 *
 * Symlinks are skipped rather than recreated.
 */
async function mirrorTree(srcRoot, destRoot) {
  const base = path.resolve(srcRoot);
  let files = 0;

  async function walk(dir, depth) {
    if (depth > 64) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;

      const target = path.resolve(destRoot, path.relative(base, full));
      assertInside(destRoot, target);

      if (entry.isDirectory()) {
        await fsp.mkdir(target, { recursive: true });
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(full, target);
        await preserveTimes(full, target);
        files += 1;
      }
    }
  }

  await fsp.mkdir(destRoot, { recursive: true });
  await walk(base, 0);
  return { files };
}

module.exports = {
  scan,
  repair,
  readProjectText,
  repairBytes,
  mirrorTree,
  STATUS,
  assertInside,
};
