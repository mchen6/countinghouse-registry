-- Schema version 2: a reconciliation pass stages what it sees and applies it only
-- after the shrink guard has passed (spec section 6.6: after an upstream reset
-- nothing is applied, not even content updates).
CREATE TABLE reconcile_stage (
  pass_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  server TEXT NOT NULL,
  official TEXT NOT NULL,
  PRIMARY KEY (pass_no, name, version)
);
