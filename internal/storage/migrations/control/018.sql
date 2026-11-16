-- Theme packages become opt-in again; retain Classical as the upgrade default.
UPDATE settings SET value = '"classical"' WHERE key = 'active_theme';
