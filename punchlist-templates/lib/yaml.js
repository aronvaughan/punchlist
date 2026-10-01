'use strict';
// One import site for the yaml dependency (the only runtime dependency plt has).
const YAML = require('yaml');

function parse(text) { return text.trim() === '' ? {} : YAML.parse(text); }

// Stable, human-diffable output: keys in insertion order, no anchors, block style.
function stringify(obj) {
  return YAML.stringify(obj, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false });
}

module.exports = { parse, stringify };
