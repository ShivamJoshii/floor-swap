-- The "warm" hue becomes "tan", so "warm" only means the vibe. Apply together with the web release that knows "tan".
update public.products set hue = 'tan' where hue = 'warm';
update public.products set colour_family = regexp_replace(colour_family, '^(light|medium|dark) warm$', '\1 tan') where colour_family ~ '^(light|medium|dark) warm$';
update public.supplier_products set hue = 'tan' where hue = 'warm';
update public.supplier_products set colour_family = regexp_replace(colour_family, '^(light|medium|dark) warm$', '\1 tan') where colour_family ~ '^(light|medium|dark) warm$';
update public.products set name = name; -- refresh search
