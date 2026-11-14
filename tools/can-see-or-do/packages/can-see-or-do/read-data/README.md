# read-data/

Package-local readers for generic actor/subject/capability answer records.

The reader accepts plain record arrays, package-set record files, or wrapped record
collections. It only understands the open record shape for `can-see-or-do-answer`.
It does not import workflow, EEAF, slots, providers, or product packages.

`read-can-see-or-do-records.d.ts` exists only so hosted TypeScript entry modules
can import the same JavaScript reader without duplicating the implementation.
