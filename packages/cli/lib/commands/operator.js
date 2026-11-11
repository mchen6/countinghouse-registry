'use strict';
// The operator commands (spec 12): thin wrappers over the operator endpoints
// (9.3, 7.2, 7.3, 6.8), signing like publish so no operator hand-signs a JWT. Each
// answers the registry's JSON body, or {removed: true} for a 204.
const {signIn, CliError, X, enc} = require('../client');

const entry = (n, v) => `${enc(n)}/versions/${enc(v)}`;

// name -> {args: its positionals, usage: its options, request(positionals, options) -> [method, path, body]}.
const COMMANDS = {
  enable: {args: ['instance', 'name', 'version'], usage: '[--remote <index>]',
    request: ([i, n, v], o) => ['PUT', `${X}/instances/${enc(i)}/enabled/${entry(n, v)}`, o.remote === undefined ? {} : {remote: integer(o.remote, '--remote')}]},
  disable: {args: ['instance', 'name', 'version'],
    request: ([i, n, v]) => ['DELETE', `${X}/instances/${enc(i)}/enabled/${entry(n, v)}`]},
  enabled: {args: ['instance'], usage: '[--since <seq>] [--limit <1-100>]',
    request: ([i], o) => {
      const q = new URLSearchParams();
      if (o.since !== undefined) q.set('since', o.since);
      if (o.limit !== undefined) q.set('limit', o.limit);
      const s = q.toString();
      return ['GET', `${X}/instances/${enc(i)}/enabled${s ? `?${s}` : ''}`];
    }},
  conflicts: {args: [], request: () => ['GET', `${X}/conflicts`]},
  acknowledge: {args: ['name', 'version'], request: ([n, v]) => ['POST', `${X}/conflicts/${entry(n, v)}/acknowledge`]},
  override: {args: ['name', 'version'], usage: '[--remove]',
    request: ([n, v], o) => (o.remove ? ['DELETE', `${X}/overrides/${entry(n, v)}`] : ['POST', `${X}/overrides/${entry(n, v)}`, {keepDeleted: true}])},
  sync: {args: [], usage: '[--upstream <name>]',
    request: (p, o) => ['POST', `${X}/mirror/sync`, o.upstream === undefined ? {} : {upstream: o.upstream}]}
};

function integer(value, flag) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new CliError(1, `${flag} must be a whole number, not ${value}`);
  return Number(value);
}

const usageOf = (name) => {
  const c = COMMANDS[name];
  return `usage: countinghouse-registry-cli ${name}${c.args.map((a) => ` <${a}>`).join('')}${c.usage ? ` ${c.usage}` : ''} --registry <base URL> --domain <d> --key <path>`;
};

// -> the response body ({removed: true} for 204).
async function operatorCommand(name, positionals, {registry, domain, keyFile, algorithm = 'ed25519', env = process.env, fetch, ...options}) {
  const c = COMMANDS[name];
  if (!c) throw new CliError(1, `unknown operator command ${name}`);
  if (positionals.length !== c.args.length) throw new CliError(1, usageOf(name));
  const [method, path, body] = c.request(positionals, options);
  const session = await signIn({registry, domain, keyFile, algorithm, env, fetch});
  const res = await session.call(method, path, body);
  return res.status === 204 ? {removed: true} : res.body;
}

module.exports = {operatorCommand, COMMANDS, usageOf};
