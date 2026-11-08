import { createHash } from 'node:crypto';

export function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

// Canonical JSON: object keys sorted, so equal data hashes equally.
export function canonical(value) {
  return JSON.stringify(value, (_, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

export const STOPWORDS = new Set(('a an and are as at be been but by can could did do does for from get give had has have '
  + 'hello hey hi how i i\'d i\'m im in is it its just let me my of on or our please quick quickly so tell than thanks that the their '
  + 'them then there these this to up us was we were what whats what\'s when where which who why will with would you your yours '
  + 'here need want like know look looking check find also any some one').split(' '));

export function words(text) {
  return (String(text).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}#_@.'-]+/gu) ?? [])
    .map(word => word.replace(/^[.'-]+|[.'-]+$/g, ''))
    .filter(Boolean);
}

export const contentWords = text => words(text).filter(word => !STOPWORDS.has(word));

// Light stemmer so "orders"/"order" and "reservations"/"reservation" share a term.
export function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && word.endsWith('es') && /(ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export const terms = text => contentWords(text).map(stem);

export function cosine(a, b) {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (const [term, weight] of a) {
    left += weight * weight;
    if (b.has(term)) dot += weight * b.get(term);
  }
  for (const weight of b.values()) right += weight * weight;
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

// Small TF-IDF index. Pluggable: an embedding search can replace it behind the same interface.
export function tfidfIndex(documents) {
  const df = new Map();
  const docs = documents.map(({ id, text }) => {
    const counts = new Map();
    for (const term of terms(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    return { id, counts };
  });
  const n = Math.max(docs.length, 1);
  const weigh = counts => new Map([...counts].map(([term, count]) =>
    [term, (1 + Math.log(count)) * Math.log(1 + n / (1 + (df.get(term) ?? 0)))]));
  const vectors = docs.map(doc => ({ id: doc.id, vector: weigh(doc.counts) }));
  return {
    query(text) {
      const counts = new Map();
      for (const term of terms(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
      const vector = weigh(counts);
      return vectors.map(doc => ({ id: doc.id, score: cosine(vector, doc.vector) }))
        .sort((x, y) => y.score - x.score);
    },
  };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december'];

// Converter for one common case: dates written in words become ISO strings.
export function isoDates(text) {
  const found = new Set(String(text).match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []);
  const lower = String(text).toLowerCase();
  const month = `(${MONTHS.join('|')}|${MONTHS.map(m => m.slice(0, 3)).join('|')})`;
  const pad = value => String(value).padStart(2, '0');
  const index = name => MONTHS.findIndex(m => m.startsWith(name.slice(0, 3))) + 1;
  for (const match of lower.matchAll(new RegExp(`\\b${month}\\.? (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})\\b`, 'g'))) {
    found.add(`${match[3]}-${pad(index(match[1]))}-${pad(match[2])}`);
  }
  for (const match of lower.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? ${month}\\.?,? (\\d{4})\\b`, 'g'))) {
    found.add(`${match[3]}-${pad(index(match[2]))}-${pad(match[1])}`);
  }
  return found;
}

// True when a value is visibly present in the request (directly or via a known converter).
export function appearsIn(request, value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return false;
  // Thousands separators (3,819.12) are ignored when looking for numbers.
  const text = String(request).toLowerCase();
  const needle = String(value).toLowerCase().trim();
  if (!needle) return false;
  if (typeof value === 'number') {
    const pattern = new RegExp(`(^|[^0-9.])${needle.replace('.', '\\.')}($|[^0-9])`);
    return [text, text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1')].some(candidate => pattern.test(candidate));
  }
  if (text.includes(needle)) return true;
  if (needle.startsWith('#') && text.includes(needle.slice(1))) return true;
  return isoDates(request).has(String(value));
}

export const round2 = value => Math.round(value * 100) / 100;

export function normalizeAnswer(value) {
  if (typeof value === 'number') return round2(value);
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (Array.isArray(value)) return value.map(normalizeAnswer);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeAnswer(item)]));
  }
  return value ?? null;
}

export const sameAnswer = (a, b) => canonical(normalizeAnswer(a)) === canonical(normalizeAnswer(b));

// Local embedding with no external service: hashed stemmed words plus character trigrams, L2-normalised.
// A profile can supply a real embedding model behind the same signature (text => number[]).
export function hashedEmbedding(text, dimensions = 512) {
  const vector = new Float64Array(dimensions);
  const add = (feature, weight) => {
    let hash = 2166136261;
    for (let i = 0; i < feature.length; i++) hash = Math.imul(hash ^ feature.charCodeAt(i), 16777619) >>> 0;
    vector[hash % dimensions] += weight;
  };
  for (const term of terms(text)) {
    add(`w:${term}`, 1);
    const padded = ` ${term} `;
    for (let i = 0; i + 3 <= padded.length; i++) add(`c:${padded.slice(i, i + 3)}`, 0.3);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return Array.from(vector, value => value / norm);
}

export function vectorCosine(a, b) {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    left += a[i] * a[i];
    right += b[i] * b[i];
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}
