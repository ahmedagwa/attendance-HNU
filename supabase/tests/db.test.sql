\set ON_ERROR_STOP on
\set QUIET on
-- Fixtures ----------------------------------------------------------------------------------
insert into auth.users (id, email) values
 ('00000000-0000-0000-0000-0000000000a1','admin@u.edu'),
 ('00000000-0000-0000-0000-0000000000b1','lect1@u.edu'),
 ('00000000-0000-0000-0000-0000000000b2','lect2@u.edu'),
 ('00000000-0000-0000-0000-0000000000c1','s1@u.edu'),
 ('00000000-0000-0000-0000-0000000000c2','s2@u.edu'),
 ('00000000-0000-0000-0000-0000000000c3','s3@u.edu');
insert into profiles (id, university_id, full_name, role) values
 ('00000000-0000-0000-0000-0000000000a1','A1','Admin','admin'),
 ('00000000-0000-0000-0000-0000000000b1','L1','Lecturer One','lecturer'),
 ('00000000-0000-0000-0000-0000000000b2','L2','Lecturer Two','lecturer'),
 ('00000000-0000-0000-0000-0000000000c1','S1','Student One','student'),
 ('00000000-0000-0000-0000-0000000000c2','S2','Student Two','student'),
 ('00000000-0000-0000-0000-0000000000c3','S3','Student Three','student');
insert into student_groups (id, group_code, name, academic_year) values
 ('00000000-0000-0000-0000-00000000f001','G1','Group 1','2026/27'),
 ('00000000-0000-0000-0000-00000000f002','G2','Group 2','2026/27');
insert into subjects (id, code, name, lecturer_id) values
 ('00000000-0000-0000-0000-00000000e001','CS101','Networks','00000000-0000-0000-0000-0000000000b1'),
 ('00000000-0000-0000-0000-00000000e002','CS202','Databases','00000000-0000-0000-0000-0000000000b2');
insert into enrollments values
 ('00000000-0000-0000-0000-00000000e001','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-00000000f001'),
 ('00000000-0000-0000-0000-00000000e001','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-00000000f001'),
 ('00000000-0000-0000-0000-00000000e001','00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-00000000f002'),
 ('00000000-0000-0000-0000-00000000e002','00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-00000000f002');
insert into halls (id, name, latitude, longitude) values ('00000000-0000-0000-0000-00000000d001','Hall A',29.85,31.33);
insert into sessions (id, subject_id, group_id, hall_id, started_by, qr_secret_enc) values
 ('00000000-0000-0000-0000-0000000005e1','00000000-0000-0000-0000-00000000e001','00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-00000000d001','00000000-0000-0000-0000-0000000000b1','x'),
 ('00000000-0000-0000-0000-0000000005e2','00000000-0000-0000-0000-00000000e002',null,'00000000-0000-0000-0000-00000000d001','00000000-0000-0000-0000-0000000000b2','x');
insert into device_installations (id, user_id, installation_id_hash) values
 ('00000000-0000-0000-0000-00000000aa01','00000000-0000-0000-0000-0000000000c1',repeat('1',64)),
 ('00000000-0000-0000-0000-00000000aa02','00000000-0000-0000-0000-0000000000c2',repeat('2',64));

create function pg_temp.as_user(uid text, r text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid, true);
  execute format('set local role %I', r);
end $$;

create function pg_temp.denied(sql text) returns boolean language plpgsql as $$
begin execute sql; return false;
exception when insufficient_privilege then return true; end $$;

create function pg_temp.assert(cond boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'ASSERTION FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;

create function pg_temp.new_attempt(sid uuid, stu uuid, ttl interval default interval '45 seconds') returns uuid language sql as $$
  insert into attendance_attempts (session_id, student_id, challenge, qr_bucket, expires_at)
  values (sid, stu, md5(random()::text || clock_timestamp()::text), 1, now() + ttl) returning id $$;

-- RLS: students ----------------------------------------------------------------------------------
begin;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.assert((select count(*) from profiles) = 1, 'student sees only their own profile');
select pg_temp.assert((select count(*) from subjects) = 1, 'student sees only enrolled subjects');
select pg_temp.assert((select count(*) from sessions) = 1, 'student sees only sessions of their subject+group');
select pg_temp.assert(pg_temp.denied('select qr_secret_enc from sessions'), 'qr_secret_enc is unreadable by browser roles');
select pg_temp.assert(pg_temp.denied('select latitude from halls'), 'hall coordinates are unreadable by students');
select pg_temp.assert(pg_temp.denied('select * from attendance_attempts'), 'attempts are server-only');
select pg_temp.assert(pg_temp.denied('select * from webauthn_credentials'), 'credentials are server-only');
select pg_temp.assert(pg_temp.denied('select * from device_installations'), 'installations are server-only');
select pg_temp.assert(pg_temp.denied('select * from rate_limits'), 'rate_limits are server-only');
select pg_temp.assert(pg_temp.denied('select prompt_payload from reverification_challenges'), 'spot-check answer is hidden');
select pg_temp.assert(pg_temp.denied($$insert into profiles (id, university_id, full_name, role) values (gen_random_uuid(),'X','X','admin')$$), 'student cannot insert profiles');
select pg_temp.assert(pg_temp.denied($$update profiles set role='admin'$$), 'student cannot self-promote');
select pg_temp.assert(pg_temp.denied('select * from audit_logs where false') = false, 'audit_logs select is allowed but row-filtered');
select pg_temp.assert((select count(*) from audit_logs) = 0, 'student sees no audit rows');
select pg_temp.assert(pg_temp.denied('select * from attendance_flags') = false and (select count(*) from attendance_flags) = 0, 'student sees no flags');
rollback;

-- RLS: lecturers ---------------------------------------------------------------------------------------
begin;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.assert((select count(*) from sessions) = 1, 'lecturer 1 sees only their own session');
select pg_temp.assert((select count(*) from profiles where role = 'student') = 3, 'lecturer sees students enrolled in their subject');
select pg_temp.assert((select count(*) from profiles where role = 'lecturer') = 1, 'lecturer sees only themselves among staff');
rollback;
begin;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select pg_temp.assert((select count(*) from sessions where id = '00000000-0000-0000-0000-0000000005e1') = 0, 'lecturer 2 cannot see lecturer 1 session');
rollback;

-- RLS: admin & anon -----------------------------------------------------------------------------------------
begin;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.assert((select count(*) from profiles) = 6, 'admin reads all profiles');
select pg_temp.assert((select count(*) from sessions) = 2, 'admin reads all sessions');
rollback;
begin;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1', 'anon');
select pg_temp.assert(pg_temp.denied('select * from profiles'), 'anon cannot read profiles');
rollback;

-- Server functions are not callable from the browser -------------------------------------------------------------
begin;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.assert(pg_temp.denied($$select * from commit_qr_attendance(gen_random_uuid(),gen_random_uuid(),null,null,'auto',null,null,null,null,null)$$), 'authenticated cannot call commit_qr_attendance');
select pg_temp.assert(pg_temp.denied($$select * from attendance_summary(gen_random_uuid())$$), 'authenticated cannot call attendance_summary');
select pg_temp.assert(pg_temp.denied($$select * from claim_device_installation(gen_random_uuid(), repeat('1',64))$$), 'authenticated cannot claim device installations directly');
select pg_temp.assert(has_function_privilege('service_role', 'public.claim_device_installation(uuid,text)', 'EXECUTE'), 'service_role can claim device installations');
rollback;

-- Device installation ownership --------------------------------------------------------------------
select pg_temp.assert(
  (select outcome from public.claim_device_installation('00000000-0000-0000-0000-0000000000c1', repeat('1', 64))) = 'existing',
  'same student can reuse the already-linked installation'
);
select pg_temp.assert(
  (select outcome from public.claim_device_installation('00000000-0000-0000-0000-0000000000c2', repeat('1', 64))) = 'owned_by_another_student',
  'a browser installation cannot be claimed by a second student'
);
select pg_temp.assert(
  (select outcome from public.claim_device_installation('00000000-0000-0000-0000-0000000000c1', repeat('3', 64))) = 'new_installation_requires_admin',
  'a second browser installation for the same student requires administrator reset'
);
select pg_temp.assert(
  (select outcome from public.claim_device_installation('00000000-0000-0000-0000-0000000000c3', repeat('3', 64))) = 'created',
  'a student with no previous device can claim the first installation'
);
do $$
declare rejected boolean := false;
begin
  begin
    insert into public.device_installations (user_id, installation_id_hash)
    values ('00000000-0000-0000-0000-0000000000c1', repeat('4', 64));
  exception when unique_violation then rejected := true;
  end;
  perform pg_temp.assert(rejected, 'database index prevents a second active installation for the same student');
end $$;

-- commit_qr_attendance ------------------------------------------------------------------------------------------------
do $$
declare
  s1 uuid := '00000000-0000-0000-0000-0000000000c1'; s2 uuid := '00000000-0000-0000-0000-0000000000c2';
  sess uuid := '00000000-0000-0000-0000-0000000005e1';
  a1 uuid; a2 uuid; a3 uuid; r record;
begin
  a1 := pg_temp.new_attempt(sess, s1);
  select * into r from commit_qr_attendance(a1, s1, null, '00000000-0000-0000-0000-00000000aa01', 'auto', 29.85, 31.33, 5, 10, 'ok');
  perform pg_temp.assert(r.outcome = 'committed' and r.record_id is not null and r.status = 'present', 'first commit succeeds and resolves auto -> present');

  select * into r from commit_qr_attendance(a1, s1, null, '00000000-0000-0000-0000-00000000aa01', 'present', 29.85, 31.33, 5, 10, 'ok');
  perform pg_temp.assert(r.outcome = 'attempt_consumed', 'replaying a consumed attempt is rejected');

  a2 := pg_temp.new_attempt(sess, s1);
  select * into r from commit_qr_attendance(a2, s1, null, '00000000-0000-0000-0000-00000000aa01', 'present', null, null, null, null, 'ok');
  perform pg_temp.assert(r.outcome = 'duplicate_student', 'second attempt for same student/session is a duplicate');
  perform pg_temp.assert((select consumed_at is not null from attendance_attempts where id = a2), 'duplicate attempt is burnt');

  a3 := pg_temp.new_attempt(sess, s2);
  select * into r from commit_qr_attendance(a3, s2, null, '00000000-0000-0000-0000-00000000aa01', 'present', null, null, null, null, 'ok');
  perform pg_temp.assert(r.outcome = 'duplicate_installation', 'same installation cannot check in a second account');

  perform pg_temp.assert((select count(*) from attendance_records where session_id = sess) = 1, 'exactly one record exists after duplicates');

  select * into r from commit_qr_attendance(pg_temp.new_attempt(sess, s2, interval '-1 second'), s2, null, null, 'present', null, null, null, null, 'ok');
  perform pg_temp.assert(r.outcome = 'attempt_expired', 'expired attempt is rejected');

  select * into r from commit_qr_attendance(gen_random_uuid(), s2, null, null, 'present', null, null, null, null, 'ok');
  perform pg_temp.assert(r.outcome = 'attempt_not_found', 'unknown attempt is rejected');

  select * into r from commit_qr_attendance(pg_temp.new_attempt(sess, s1), s2, null, null, 'present', null, null, null, null, 'ok');
  perform pg_temp.assert(r.outcome = 'attempt_not_found', 'attempt belonging to another student is rejected');

  update sessions set started_at = now() - interval '2 hours' where id = '00000000-0000-0000-0000-0000000005e2';
  perform pg_temp.assert((select status from commit_qr_attendance(pg_temp.new_attempt('00000000-0000-0000-0000-0000000005e2', '00000000-0000-0000-0000-0000000000c3'), '00000000-0000-0000-0000-0000000000c3', null, null, 'auto', null, null, null, null, 'ok')) = 'late',
                         'auto status resolves to late after the late threshold (database clock)');
  delete from attendance_records where session_id = '00000000-0000-0000-0000-0000000005e2';

  update sessions set status = 'closed', ended_at = now() where id = sess;
  select * into r from commit_qr_attendance(pg_temp.new_attempt(sess, s2), s2, null, null, 'present', null, null, null, null, 'ok');
  perform pg_temp.assert(r.outcome = 'session_closed', 'closed session rejects commits');
end $$;

-- Constraints, audit, helpers --------------------------------------------------------------------------------------------
do $$
declare ok boolean;
begin
  begin
    insert into attendance_records (session_id, student_id, status, source, recorded_by)
    values ('00000000-0000-0000-0000-0000000005e2','00000000-0000-0000-0000-0000000000c3','present','manual','00000000-0000-0000-0000-0000000000b2');
    ok := false;
  exception when check_violation then ok := true; end;
  perform pg_temp.assert(ok, 'manual record without a reason is rejected');

  insert into attendance_records (session_id, student_id, status, source, recorded_by, manual_reason)
  values ('00000000-0000-0000-0000-0000000005e2','00000000-0000-0000-0000-0000000000c3','present','manual','00000000-0000-0000-0000-0000000000b2','Phone battery died');
  perform pg_temp.assert(true, 'manual record with reason is accepted');

  insert into audit_logs (actor_id, action, entity_type) values (null, 'test', 'test');
  begin update audit_logs set action = 'tampered'; ok := false; exception when insufficient_privilege then ok := true; end;
  perform pg_temp.assert(ok, 'audit_logs rows cannot be updated');
  begin delete from audit_logs; ok := false; exception when insufficient_privilege then ok := true; end;
  perform pg_temp.assert(ok, 'audit_logs rows cannot be deleted');
  begin truncate audit_logs; ok := false; exception when insufficient_privilege then ok := true; end;
  perform pg_temp.assert(ok, 'audit_logs cannot be truncated');

  perform pg_temp.assert(rate_limit_hit('k', 60, 2) and rate_limit_hit('k', 60, 2) and not rate_limit_hit('k', 60, 2), 'rate limiter blocks the 3rd hit in a window');

  perform pg_temp.assert((select attended from attendance_summary('00000000-0000-0000-0000-0000000000c1') where subject_code = 'CS101') = 1
                         and (select sessions_held from attendance_summary('00000000-0000-0000-0000-0000000000c1') where subject_code = 'CS101') = 1,
                         'attendance_summary counts closed sessions and present records');
  perform pg_temp.assert((select absent from session_summary('00000000-0000-0000-0000-0000000005e1')) = 1, 'session_summary reports absent students');

  update attendance_records set latitude = 1, longitude = 1, checked_in_at = now() - interval '40 days' where session_id = '00000000-0000-0000-0000-0000000005e1';
  perform pg_temp.assert(purge_raw_gps() = 1, 'raw GPS older than 30 days is purged');
end $$;
\echo ALL DB TESTS PASSED
