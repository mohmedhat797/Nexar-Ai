/**
 * Turns a title into a URL slug: lower case, ASCII letters and digits, words joined by "-".
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
