module.exports = function nativePgDisabled() {
  throw new Error('Native PostgreSQL driver is unavailable in the backup preflight runtime');
};
