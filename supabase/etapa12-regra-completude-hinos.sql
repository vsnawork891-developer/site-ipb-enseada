-- Etapa 12: classificação explícita de hinos na biblioteca musical.
-- Execute uma vez depois da migration da Etapa 10 (e da Etapa 11, se aplicada).

alter table public.songs_catalog
  add column if not exists is_hymn boolean not null default false;

comment on column public.songs_catalog.is_hymn is
  'Indica se o item é um hino e deve seguir os critérios especiais de completude da biblioteca.';
