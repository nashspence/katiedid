-- Notify PostgREST to reload its schema after migrations complete.
select pg_notify('pgrst', 'reload schema');
