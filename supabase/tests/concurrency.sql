insert into auth.users (id) select ('10000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid from generate_series(1, 100) g;
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000dd'), ('00000000-0000-0000-0000-0000000000b1');
insert into profiles (id, university_id, full_name, role)
  select ('10000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'ST' || g, 'Student ' || g, 'student' from generate_series(1, 100) g;
insert into profiles values ('00000000-0000-0000-0000-0000000000dd','DUP','Racer','student', 'active', now(), now());
insert into profiles values ('00000000-0000-0000-0000-0000000000b1','L1','Lecturer','lecturer', 'active', now(), now());
insert into student_groups (id, group_code, name, academic_year) values ('00000000-0000-0000-0000-00000000f001','G1','Group 1','2026/27');
insert into subjects (id, code, name, lecturer_id) values ('00000000-0000-0000-0000-00000000e001','CS101','Networks','00000000-0000-0000-0000-0000000000b1');
insert into halls (id, name, latitude, longitude) values ('00000000-0000-0000-0000-00000000d001','Hall A',29.85,31.33);
insert into sessions (id, subject_id, group_id, hall_id, started_by, qr_secret_enc)
  values ('00000000-0000-0000-0000-0000000005e1','00000000-0000-0000-0000-00000000e001','00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-00000000d001','00000000-0000-0000-0000-0000000000b1','x');
insert into device_installations (user_id, installation_id_hash, id)
  select ('10000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'h' || g, ('20000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid from generate_series(1, 100) g;
insert into device_installations (user_id, installation_id_hash, id)
  values ('00000000-0000-0000-0000-0000000000dd', 'hdd', '20000000-0000-0000-0000-0000000000dd');

create table tmp_work (attempt_id uuid, student_id uuid, installation_id uuid);
with a as (
  insert into attendance_attempts (session_id, student_id, challenge, qr_bucket, expires_at)
  select '00000000-0000-0000-0000-0000000005e1', ('10000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
         md5('c' || g || random()::text), 1, now() + interval '5 minutes'
    from generate_series(1, 100) g
  returning id, student_id)
insert into tmp_work select a.id, a.student_id, ('20000000-0000-0000-0000-' || right(a.student_id::text, 12))::uuid from a;
with a as (
  insert into attendance_attempts (session_id, student_id, challenge, qr_bucket, expires_at)
  select '00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-0000000000dd',
         md5('dup' || g || random()::text), 1, now() + interval '5 minutes'
    from generate_series(1, 20) g
  returning id, student_id)
insert into tmp_work select id, student_id, '20000000-0000-0000-0000-0000000000dd' from a;
grant select on tmp_work to public;
