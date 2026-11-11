'use strict';
// A stand-in for Task 6's auth: every request carries `actor` (null: no token),
// and permissions are decided by the same function the real auth uses.
const {authFor} = require('../../lib/auth/permissions');

function fakeAuth(actor) {
  return authFor(() => actor);
}

const publisher = (namespaces, extra = {}) => ({kind: 'publisher', sub: 'test-key', fp: 'ed25519:AAAAAAAA', namespaces, operate: false, ...extra});

module.exports = {fakeAuth, publisher};
