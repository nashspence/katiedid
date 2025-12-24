FROM flyway/flyway:10
COPY db/schema.sql /flyway/sql/V1__initial_schema.sql
