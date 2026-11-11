-- Schema version 4: enables by name and version (spec section 9), for the change
-- sequence moves (touchEnables), the public hosting count and the operator's
-- per-instance view.
CREATE INDEX enables_entry ON enables (name, version);

-- The sequence value of the enable (PUT) that started the current cycle: results
-- after it are the cycle's (its current hash, and the retries it accepts).
ALTER TABLE enables ADD COLUMN requested_seq INTEGER NOT NULL DEFAULT 0;
