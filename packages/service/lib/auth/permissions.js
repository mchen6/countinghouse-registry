'use strict';
// What a token's actor may do (spec section 10). An actor is
// {kind: 'publisher', sub, keyFp, namespaces, operate} or {kind: 'instance', sub,
// instance}; a permission is 'publish:<server name>', 'operate' or
// 'instance:<id>'. Task 6's real auth and the tests' fakeAuth both decide here.
const {problem} = require('../http/problem');

function allows(actor, perm) {
  if (!actor) return false;
  if (perm.startsWith('publish:')) {
    const name = perm.slice('publish:'.length);
    return actor.kind === 'publisher' && (actor.namespaces || []).some((ns) => name.startsWith(ns));
  }
  if (perm === 'operate') return actor.kind === 'publisher' && actor.operate === true;
  if (perm.startsWith('instance:')) return actor.kind === 'instance' && actor.instance === perm.slice('instance:'.length);
  return false;
}

function denial(actor, perm) {
  if (perm.startsWith('publish:')) {
    // upstream's buildPermissionErrorMessage
    const ns = actor.kind === 'publisher' ? actor.namespaces || [] : [];
    return ns.length ? `You do not have permission to publish this server. You have permission to publish: ${ns.join(', ')}`
      : 'You do not have permission to publish this server. You do not have any publish permissions';
  }
  return 'You do not have permission for this operation';
}

// An auth object for createApp: require(perm) is middleware; perm may be a
// function of the request (the server name is in the path or the body).
// getActor(req) -> actor | null (no or invalid token: 401).
function authFor(getActor) {
  return {
    require: (perm) => (req, res, next) => {
      const actor = getActor(req);
      if (!actor) return problem(res, 401, 'Invalid or expired Registry JWT token');
      const p = typeof perm === 'function' ? perm(req) : perm;
      if (!allows(actor, p)) return problem(res, 403, denial(actor, p));
      req.actor = actor;
      return next();
    }
  };
}

// Until Task 6 wires the real exchanges, nothing can authenticate.
const denyAll = authFor(() => null);

module.exports = {allows, authFor, denyAll};
