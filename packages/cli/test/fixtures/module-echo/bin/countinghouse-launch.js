#!/usr/bin/env node
'use strict';
// The fixture's launcher stand-in (N1's scaffold emits the real one, spec 11.1):
// the generator only checks that package.json names it; it is never run in tests.
process.stderr.write('countinghouse-module-echo: fixture launcher, not runnable\n');
process.exit(2);
