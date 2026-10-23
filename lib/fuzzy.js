// Fuzzy matching for app search: finds "Libre Writer" for "lbrwrt" and
// "Firefox" for "firfox". Used after the exact, prefix and substring
// matches, so it only adds results; it never reorders exact hits.
// Shared by the shell and prefs: no gnome-shell imports here.

/** Edit distance with swaps of neighbours (Damerau–Levenshtein, optimal string alignment). */
function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max)
        return max + 1;
    let prev2 = null;
    let prev = Array.from({length: b.length + 1}, (_v, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                d = Math.min(d, prev2[j - 2] + 1);
            cur.push(d);
            rowMin = Math.min(rowMin, d);
        }
        if (rowMin > max)
            return max + 1;
        prev2 = prev;
        prev = cur;
    }
    return prev[b.length];
}

/** Typos allowed for a query of this length. */
function allowedTypos(n) {
    return n < 4 ? 0 : n < 7 ? 1 : 2;
}

/**
 * How well `query` fuzzily matches `text` (both lower case): a penalty
 * (lower is better), or -1 when it does not match. Two ways to match:
 * - the letters of the query appear in order (gaps cost a little);
 * - a word of the text starts with the query, give or take a typo or two.
 */
export function fuzzyScore(query, text) {
    if (!query || !text)
        return -1;
    let best = -1;
    // Letters in order, e.g. "gimp" in "GNU Image Manipulation Program".
    let pos = -1, gaps = 0;
    for (const ch of query) {
        if (ch === ' ')
            continue;
        const next = text.indexOf(ch, pos + 1);
        if (next < 0) {
            gaps = -1;
            break;
        }
        if (pos >= 0 && next > pos + 1)
            gaps++;
        pos = next;
    }
    if (gaps >= 0 && query.replace(/\s/g, '').length >= 2)
        best = 10 + gaps;
    // Typos against the start of each word, e.g. "firfox" ~ "firefox".
    const typos = allowedTypos(query.length);
    if (typos) {
        for (const word of text.split(/[\s\-_.]+/)) {
            if (word.length < 3)
                continue;
            const d = Math.min(editDistance(query, word.slice(0, query.length), typos),
                editDistance(query, word, typos));
            if (d <= typos && (best < 0 || d < best))
                best = d;
        }
    }
    return best;
}
