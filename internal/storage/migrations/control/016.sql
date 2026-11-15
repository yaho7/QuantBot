ALTER TABLE performance_hosts RENAME COLUMN key_digest TO source_digest;
CREATE UNIQUE INDEX performance_hosts_source ON performance_hosts(scope, source_digest);
