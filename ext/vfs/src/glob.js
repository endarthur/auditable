import { path } from './path.js';

function _globToRegex(pattern) {
  // Split pattern into segments
  const segments = pattern.split('/').filter(Boolean);
  let regexParts = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === '**') {
      regexParts.push('(?:.+/)?');
    } else {
      // Escape regex chars except * and ?
      let part = '';
      for (const ch of seg) {
        if (ch === '*') part += '[^/]*';
        else if (ch === '?') part += '[^/]';
        else if ('.+^${}()|[]\\'.includes(ch)) part += '\\' + ch;
        else part += ch;
      }
      regexParts.push(part + '/');
    }
  }

  // Join and fix trailing slash
  let regex = '/' + regexParts.join('');
  // Remove trailing slash for the final match
  if (regex.endsWith('/')) regex = regex.slice(0, -1);

  return new RegExp('^' + regex + '$');
}

function _staticPrefix(pattern) {
  const segments = pattern.split('/').filter(Boolean);
  const prefix = [];
  for (const seg of segments) {
    if (seg === '**' || seg.includes('*') || seg.includes('?')) break;
    prefix.push(seg);
  }
  return '/' + prefix.join('/');
}

async function vfsGlob(vfs, pattern) {
  const normalized = path.normalize(pattern);
  const regex = _globToRegex(normalized);
  const prefix = _staticPrefix(normalized);

  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await vfs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = dir === '/' ? '/' + name : dir + '/' + name;
      if (regex.test(full)) results.push(full);
      // Recurse into directories if pattern has **
      try {
        const info = await vfs.stat(full);
        if (info.type === 'directory') {
          await walk(full);
        }
      } catch {
        // stat failed, skip
      }
    }
  }

  await walk(prefix === '/' ? '/' : prefix);
  return results.sort();
}

export { vfsGlob };
