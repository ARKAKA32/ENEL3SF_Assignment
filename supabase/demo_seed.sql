-- Optional DEVELOPMENT seed. Fictional incidents, clearly labelled; no fake Auth accounts.
-- Re-running does not overwrite edited demo incidents. Do not use in a live emergency queue.
insert into public.incidents(incident_id,title,description,category,severity,status,location_text,location_source,is_anon)
values
('de000000-0000-4000-8000-000000000001','DEMO: Smoke at a warehouse','Fictional test report: smoke observed near a warehouse.','fire','high','new','Demo warehouse, east entrance','manual',true),
('de000000-0000-4000-8000-000000000002','DEMO: Medical assistance','Fictional test report: someone needs medical assistance.','medical','critical','acknowledged','Demo sports field','manual',true),
('de000000-0000-4000-8000-000000000003','DEMO: Suspicious activity','Fictional test report: suspicious activity near a parking area.','police','medium','new','Demo parking area B','manual',true),
('de000000-0000-4000-8000-000000000004','DEMO: Welfare concern','Fictional test report: a child welfare concern requires assessment.','child_services','medium','in_progress','Demo community centre','manual',true),
('de000000-0000-4000-8000-000000000005','DEMO: Minor obstruction','Fictional test report: a small obstruction has been removed.','other','low','resolved','Demo pedestrian path','manual',true)
on conflict(incident_id) do nothing;
