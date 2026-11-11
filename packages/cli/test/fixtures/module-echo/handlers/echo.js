'use strict';
// The fixture module's only handler: answers with the text it was given.
module.exports = {echo: (input, cb) => cb(null, {text: input.text})};
