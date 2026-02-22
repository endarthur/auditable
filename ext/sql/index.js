// @auditable/sql — SQL language tag with syntax highlighting and completions
// Provides the sql tagged template literal. The actual database engine
// (sql.js, etc.) is loaded separately by the user.

// ── sql tagged template literal ──

export function sql(strings, ...values) {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) result += values[i] + strings[i + 1];
  return result;
}

// ── SQL tokenizer (for syntax highlighting) ──

const SQL_KEYWORDS = new Set([
  'select','from','where','insert','update','delete','create','drop','alter',
  'table','index','view','into','values','set','join','left','right','inner',
  'outer','cross','natural','on','as','and','or','not','in','is','null',
  'like','glob','between','exists','having','group','by','order','asc','desc',
  'limit','offset','union','all','distinct','case','when','then','else','end',
  'primary','key','foreign','references','unique','check','default','constraint',
  'if','begin','commit','rollback','transaction','trigger','autoincrement',
  'cascade','restrict','replace','abort','fail','ignore','conflict','temporary',
  'temp','explain','query','plan','attach','detach','database','pragma','vacuum',
  'reindex','analyze','rename','column','add','with','recursive','returning',
  'true','false','except','intersect','collate','nocase','rowid',
]);

const SQL_TYPES = new Set([
  'integer','real','text','blob','numeric','int','float','double','varchar',
  'char','boolean','date','datetime','timestamp','bigint','smallint','tinyint',
  'decimal','clob','nvarchar','nchar','none','any',
]);

const SQL_FUNCTIONS = new Set([
  'count','sum','avg','min','max','total','group_concat',
  'abs','round','random','typeof','coalesce','ifnull','nullif','iif',
  'length','substr','substring','replace','trim','ltrim','rtrim',
  'upper','lower','instr','hex','quote','unicode','zeroblob','printf',
  'char','likelihood','likely','unlikely',
  'date','time','julianday','strftime','unixepoch','timediff',
  'json','json_array','json_extract','json_insert','json_object',
  'json_remove','json_replace','json_type','json_valid','json_group_array',
  'json_group_object','json_each','json_tree',
  'last_insert_rowid','changes','total_changes',
  'load_extension','sqlite_version',
  'cast','exists',
]);

function tokenizeSql(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    // line comment --
    if (code[i] === '-' && code[i + 1] === '-') {
      const start = i;
      while (i < len && code[i] !== '\n') i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }
    // block comment /* */
    if (code[i] === '/' && code[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(code[i - 1] === '*' && code[i] === '/')) i++;
      if (i < len) i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }
    // single-quoted string
    if (code[i] === "'") {
      const start = i;
      i++;
      while (i < len) {
        if (code[i] === "'" && code[i + 1] === "'") { i += 2; continue; } // escaped quote
        if (code[i] === "'") { i++; break; }
        i++;
      }
      tokens.push({ type: 'str', text: code.slice(start, i) });
      continue;
    }
    // double-quoted identifier
    if (code[i] === '"') {
      const start = i;
      i++;
      while (i < len && code[i] !== '"') i++;
      if (i < len) i++;
      tokens.push({ type: 'id', text: code.slice(start, i) });
      continue;
    }
    // backtick-quoted identifier (MySQL-style, SQLite supports it)
    if (code[i] === '`') {
      const start = i;
      i++;
      while (i < len && code[i] !== '`') i++;
      if (i < len) i++;
      tokens.push({ type: 'id', text: code.slice(start, i) });
      continue;
    }
    // numbers
    if (/\d/.test(code[i]) || (code[i] === '.' && i + 1 < len && /\d/.test(code[i + 1]))) {
      const start = i;
      if (code[i] === '0' && (code[i + 1] === 'x' || code[i + 1] === 'X')) {
        i += 2;
        while (i < len && /[0-9a-fA-F]/.test(code[i])) i++;
      } else {
        while (i < len && /[0-9.eE+-]/.test(code[i])) i++;
      }
      tokens.push({ type: 'num', text: code.slice(start, i) });
      continue;
    }
    // parameter placeholders: ?, :name, @name, $name
    if (code[i] === '?' || ((code[i] === ':' || code[i] === '@' || code[i] === '$') && i + 1 < len && /[a-zA-Z_]/.test(code[i + 1]))) {
      const start = i;
      i++;
      while (i < len && /\w/.test(code[i])) i++;
      tokens.push({ type: 'const', text: code.slice(start, i) });
      continue;
    }
    // identifiers / keywords
    if (/[a-zA-Z_]/.test(code[i])) {
      const start = i;
      while (i < len && /\w/.test(code[i])) i++;
      const word = code.slice(start, i);
      const lower = word.toLowerCase();
      if (SQL_KEYWORDS.has(lower)) {
        tokens.push({ type: 'kw', text: word });
      } else if (SQL_TYPES.has(lower)) {
        tokens.push({ type: 'const', text: word });
      } else if (SQL_FUNCTIONS.has(lower) || (i < len && code[i] === '(')) {
        tokens.push({ type: 'fn', text: word });
      } else {
        tokens.push({ type: 'id', text: word });
      }
      continue;
    }
    // operators
    if ('=<>!|+-*/%'.includes(code[i])) {
      // multi-char operators: <=, >=, <>, !=, ||
      const start = i;
      i++;
      if (i < len && '=<>|'.includes(code[i])) i++;
      tokens.push({ type: 'op', text: code.slice(start, i) });
      continue;
    }
    // punctuation
    if ('()[];,.'.includes(code[i])) {
      tokens.push({ type: 'punc', text: code[i] });
      i++;
      continue;
    }
    // whitespace / other
    tokens.push({ type: '', text: code[i] });
    i++;
  }

  return tokens;
}

// ── SQL completions ──

function sqlCompletions() {
  const items = [];
  for (const w of SQL_KEYWORDS)  items.push({ text: w.toUpperCase(), kind: 'kw' });
  for (const w of SQL_TYPES)     items.push({ text: w.toUpperCase(), kind: 'const' });
  for (const w of SQL_FUNCTIONS) items.push({ text: w.toLowerCase(), kind: 'fn' });
  return items;
}

// ── Self-registration ──

if (typeof window !== 'undefined') {
  if (!window._taggedLanguages) window._taggedLanguages = {};
  window._taggedLanguages.sql = { tokenize: tokenizeSql, completions: sqlCompletions };
}
