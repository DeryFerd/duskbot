// An append-only log that never outgrows its cap: past `maxBytes` the file becomes `<file>.1` (replacing the last one)
// and a fresh file starts, so at most about twice the cap stays on disk however long the app runs.
import nodeFs from "node:fs";
import path from "node:path";

export const SERVER_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** @param {{ file: string, maxBytes?: number, fs?: typeof nodeFs }} options */
export function createCappedLog({ file, maxBytes = SERVER_LOG_MAX_BYTES, fs = nodeFs }) {
  let fd = null;
  let size = 0;

  const shut = () => {
    if (fd === null) return;
    try { fs.closeSync(fd); } catch {}
    fd = null;
  };

  // closed first: Windows refuses to rename a file that is still open, and the log then grew without bound there
  function rotate() {
    shut();
    try { fs.renameSync(file, `${file}.1`); } catch {}
    size = 0;
  }

  function open() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size >= maxBytes) rotate();
    fd = fs.openSync(file, "a");
  }

  return {
    // each line is written before write returns, so a rotation never strands a pending one
    write(text) {
      const bytes = Buffer.byteLength(text);
      try {
        if (fd === null) open();
        else if (size > 0 && size + bytes > maxBytes) {
          rotate();
          open();
        }
        fs.writeSync(fd, text);
        size += bytes;
      } catch {
        shut();
      }
    },
    close() {
      shut();
    },
  };
}
