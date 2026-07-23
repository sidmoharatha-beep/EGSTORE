-- Default accounts — password for all three is: ChangeMe123!
-- CHANGE THESE PASSWORDS immediately after first login.
-- (log in as admin, then re-run scripts/hash_password.js and UPDATE the row,
--  or use `wrangler d1 execute` directly.)

INSERT INTO users (username, password_hash, name, role) VALUES
('admin',   '3949bf96719e3db6fba35b986ef88c2c:b85c8a8d90b69c810b39a57e8bdbdf587288434be06f1abdb36d8069950f8f3b', 'Administrator', 'admin'),
('store1',  'eeaf5f534e2858dbb3cf95018dea0ee7:410582ed6303f8e5b3112e9646158a6e695c048e632d6ea3b3b47b6335b94411', 'Store Incharge', 'store_incharge'),
('issuer1', '171794e48f4ce70b13afe4ec2738220f:08dd027b3fec50d1849638ce20c18820de5404b0830a3076c3feab9912cc73a1', 'Issuer', 'issuer');
