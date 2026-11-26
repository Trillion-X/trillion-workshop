-- own_code(code, email): whether this referral code belongs to this email, for a site's reader login that must never read
-- referral_codes.email. Made by the database's owner (SET ROLE to it first, so the SECURITY DEFINER function belongs to the owner
-- and never to a superuser), after the referral_codes table. tool:give-a-referred-buyer-their-checkout-discount calls it to
-- refuse a buyer's own code; the reader is granted EXECUTE on it and SELECT on only the columns read-data/reader-rights.json
-- names, so no email reaches it. The comparison is the tool's own rule: the code as the referral rules normalise it (the tool
-- hands it over already trimmed and upper case), the email trimmed and compared without case. A null, empty or unknown code or
-- email answers false, never an error.
CREATE OR REPLACE FUNCTION public.own_code(code text, email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
SELECT coalesce(btrim($2) <> '' AND EXISTS (
  SELECT 1 FROM public.referral_codes r WHERE r.code = $1 AND lower(r.email) = lower(btrim($2))), false)
$function$;
REVOKE ALL ON FUNCTION public.own_code(text, text) FROM PUBLIC;
-- Then, as a role that may grant: GRANT EXECUTE ON FUNCTION public.own_code(text, text) TO <the site's reader login>;
