-- Rulează în Supabase > SQL Editor
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  free_listing_used boolean not null default false,  -- true după primul anunț gratuit
  created_at timestamptz not null default now()
);

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('trip','request')),   -- cursă / colet
  from_city text not null,
  to_city text not null,
  travel_date date,
  travel_time text,
  transport text,           -- Mașină personală / Tren
  size text,                -- Mic / Mediu / Mare
  description text not null,
  price_text text,
  contact text,
  is_paid boolean not null default false,
  stripe_session_id text,
  created_at timestamptz not null default now()
);
create index on public.listings (is_paid, from_city, to_city);
create index on public.listings (user_id);

-- Profil creat automat la înregistrare
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- RLS: scrierile se fac DOAR din server (service role, ocolește RLS)
alter table public.profiles enable row level security;
alter table public.listings enable row level security;
create policy "profile propriu" on public.profiles for select using (auth.uid() = id);
create policy "anunțuri plătite publice, ale mele mereu" on public.listings
  for select using (is_paid = true or auth.uid() = user_id);
