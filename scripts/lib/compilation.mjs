export function canonicalizeActionComments(text) {
  // gh-aw's action cache may append a SHA as its own display label. Keep meaningful
  // version labels and every manifest/body byte; remove only an identical suffix
  // on action references or their generated header inventory.
  return text
    .replace(/^( {0,8}(?:- )?uses: \S+@([a-f0-9]{40}))[ \t]+#[ \t]+\2[ \t]*$/gm, "$1")
    .replace(/^(# +-[ \t]+\S+@([a-f0-9]{40}))[ \t]+#[ \t]+\2[ \t]*$/gm, "$1");
}
