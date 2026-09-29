'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.resolve(process.env.MCPT_DATA || path.join(ROOT, 'data'));

module.exports = {
  ROOT,
  DATA,
  SERVERS: path.join(DATA, 'servers'),
  CACHE: path.join(DATA, 'cache'),
  JAVA: path.join(DATA, 'java'),
  PUBLIC: path.join(ROOT, 'public'),
  CONFIG_FILE: path.join(DATA, 'instances.json'),
};
