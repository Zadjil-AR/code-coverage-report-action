/**
 * Custom Jest snapshot serializer that formats arrays of numbers
 * with up to 20 items per line, reducing vertical space in snapshots.
 */
const ITEMS_PER_LINE = 20;

module.exports = {
  test(val) {
    return (
      Array.isArray(val) &&
      val.length > 0 &&
      val.every(x => typeof x === 'number')
    );
  },
  serialize(val, config, indentation) {
    const childIndent = indentation + config.indent;
    const chunks = [];
    for (let i = 0; i < val.length; i += ITEMS_PER_LINE) {
      chunks.push(val.slice(i, i + ITEMS_PER_LINE).join(', '));
    }
    const lines = chunks.map(c => `${childIndent}${c},`).join('\n');
    return `[\n${lines}\n${indentation}]`;
  },
};
