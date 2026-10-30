-- Demo room + the 12-table seed layout (also what room/reset restores).
insert into demo_rooms (id) values ('jsconf-mx-2026') on conflict (id) do nothing;

select demo_seed_tables('jsconf-mx-2026')
where not exists (select 1 from demo_tables where room_id = 'jsconf-mx-2026');
