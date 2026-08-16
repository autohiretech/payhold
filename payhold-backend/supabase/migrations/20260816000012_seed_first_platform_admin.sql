-- `platform_admins` has existed since `20260805000001` with no seed and no
-- writer anywhere in this repo — nobody has ever been in it. That is why
-- Cron and Master admin 404 for every dashboard session today: the gate is
-- doing exactly what §16 asks (a tenant `owner` is not PayHold staff), but
-- with the table empty it refuses everyone, including the person who is
-- actually meant to hold it.
--
-- Keyed by email rather than a hand-copied uuid, resolved against `auth.users`
-- at apply time: `j.horugavye@alustudent.com` is the dashboard session that
-- hit the 404 investigating the Cron/Admin pages. `on conflict do nothing`
-- makes this safe to re-run, and the `where` guards against silently
-- inserting nothing if the email is ever wrong rather than granting the
-- wrong account.
insert into platform_admins (auth_user_id)
select id from auth.users where email = 'j.horugavye@alustudent.com'
on conflict (auth_user_id) do nothing;
