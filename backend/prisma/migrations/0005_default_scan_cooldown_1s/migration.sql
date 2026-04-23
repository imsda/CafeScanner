-- Set new default scan cooldown behavior to 1 second.
UPDATE "Setting"
SET "scannerCooldownSeconds" = 1
WHERE "scannerCooldownSeconds" = 4;
