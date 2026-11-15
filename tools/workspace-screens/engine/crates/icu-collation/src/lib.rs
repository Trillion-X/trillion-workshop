// crates/icu-collation/src/lib.rs
//
// Purpose: The engine's one tool-label collation: ICU 78.2, built from its pinned source (build.rs) and linked statically on every computer.
// Invariants: The linked ICU must report exactly the versions, locale names, attributes and every original probe in profile.json,
//   or no collation is made. The explicit locale only, never the process default.
// Security: No file paths, no dynamic loading, bounded UTF-16 and fixed error values.
// AI Assistant Directive: Keep the profile checks. Do not claim more than the probes show.

use serde::Deserialize;
use std::{
    cmp::Ordering,
    ffi::{c_char, c_void, CStr, CString},
    ptr::NonNull,
    sync::Mutex,
};

/// The most UTF-16 units one call takes.
pub const MAX_PROBE_UNITS: usize = 1024 * 1024;
const MAX_LOCALE_BYTES: usize = 256;
const MAX_PROBES: usize = 4096;
const MIN_PROBES: usize = 31;
const ICU_ATTRIBUTES: [i32; 7] = [0, 1, 2, 3, 4, 5, 7];
const ATTR_NORMALIZATION_MODE: i32 = 4;
const ATTR_STRENGTH: i32 = 5;
const UCOL_ON: i32 = 17;
const UCOL_TERTIARY: i32 = 2;
const ULOC_ACTUAL_LOCALE: i32 = 0;
const ULOC_VALID_LOCALE: i32 = 1;
const U_BUFFER_OVERFLOW_ERROR: i32 = 15;

/// The profile DATA this crate is qualified against. It is built in, so every computer reads the same bytes.
const PROFILE: &str = include_str!("../profile.json");

/// Why a call was refused. Fixed values only: no ICU text, no paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Source,
    Bounds,
}

/// A comparison made by the original JavaScript runtime for these UTF-16 operands. `sign` is exactly -1, 0 or 1.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub left: Vec<u16>,
    pub right: Vec<u16>,
    pub sign: i8,
}

/// The exact ICU metadata and original-runtime probes a linked ICU must match. Parsing alone is not evidence.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    /// Explicit ICU locale identifier. Empty is refused; the process locale is never used.
    pub locale_id: String,
    pub valid_locale: String,
    pub actual_locale: String,
    pub icu_version: [u8; 4],
    pub data_version: [u8; 4],
    pub collator_version: [u8; 4],
    pub uca_version: [u8; 4],
    /// Values for French, alternate, case-first, case-level, normalization,
    /// strength and numeric attributes, in that order.
    pub attributes: [i32; 7],
    pub probes: Vec<Probe>,
}

/// The engine's own profile, parsed.
pub fn engine_profile() -> Result<Profile, Error> {
    serde_json::from_str(PROFILE).map_err(|_| Error::Source)
}

/// A linked ICU that has matched a profile exactly. Calls are serialized by its collator mutex.
pub struct Collation {
    collator: Mutex<Collator>,
    /// The profile's explicit locale, for the locale-sensitive case calls.
    locale: CString,
}

impl Collation {
    /// The engine's collation: the linked ICU checked against the engine's profile.
    pub fn engine() -> Result<Self, Error> {
        Self::open(&engine_profile()?)
    }

    /// Qualify the linked ICU against an exact profile: versions, locale names, attributes and every probe.
    pub fn open(profile: &Profile) -> Result<Self, Error> {
        validate(profile)?;
        let locale = CString::new(profile.locale_id.as_bytes()).map_err(|_| Error::Source)?;
        let mut status = 0;
        let raw = NonNull::new(unsafe { ucol_open(locale.as_ptr(), &mut status) }).ok_or(Error::Source)?;
        // Owned from here, so every early return closes it.
        let collator = Collator(raw);
        if status > 0 {
            return Err(Error::Source);
        }
        set_attribute(&collator, ATTR_NORMALIZATION_MODE, UCOL_ON)?;
        set_attribute(&collator, ATTR_STRENGTH, UCOL_TERTIARY)?;
        check_metadata(&collator, profile)?;
        let collation = Self {
            collator: Mutex::new(collator),
            locale,
        };
        for probe in &profile.probes {
            if sign_of(collation.compare(&probe.left, &probe.right)?) != probe.sign {
                return Err(Error::Source);
            }
        }
        Ok(collation)
    }

    /// One comparison through the linked collator.
    pub fn compare(&self, left: &[u16], right: &[u16]) -> Result<Ordering, Error> {
        if left.len() > MAX_PROBE_UNITS || right.len() > MAX_PROBE_UNITS {
            return Err(Error::Bounds);
        }
        let left_len = i32::try_from(left.len()).map_err(|_| Error::Bounds)?;
        let right_len = i32::try_from(right.len()).map_err(|_| Error::Bounds)?;
        let collator = self.collator.lock().map_err(|_| Error::Source)?;
        let result = unsafe {
            ucol_strcoll(
                collator.0.as_ptr(),
                left.as_ptr(),
                left_len,
                right.as_ptr(),
                right_len,
            )
        };
        Ok(result.cmp(&0))
    }

    /// Unicode uppercase in the profile's explicit locale.
    pub fn uppercase(&self, value: &[u16]) -> Result<Vec<u16>, Error> {
        self.case(value, self.locale.as_ptr(), u_str_to_upper)
    }

    /// Unicode lowercase in the profile's explicit locale.
    pub fn lowercase(&self, value: &[u16]) -> Result<Vec<u16>, Error> {
        self.case(value, self.locale.as_ptr(), u_str_to_lower)
    }

    /// ECMAScript String.prototype.toLowerCase: Unicode default casing, independent of the locale. ICU's root locale
    /// is an empty, non-null C string.
    pub fn default_lowercase(&self, value: &[u16]) -> Result<Vec<u16>, Error> {
        self.case(value, b"\0".as_ptr().cast(), u_str_to_lower)
    }

    fn case(&self, value: &[u16], locale: *const c_char, case: UStrCase) -> Result<Vec<u16>, Error> {
        if value.len() > MAX_PROBE_UNITS {
            return Err(Error::Bounds);
        }
        let source_len = i32::try_from(value.len()).map_err(|_| Error::Bounds)?;
        let _serialized = self.collator.lock().map_err(|_| Error::Source)?;
        let mut status = 0;
        // SAFETY: ICU permits a null destination at capacity zero. The source is the raw UTF-16 with its explicit
        // length, including embedded NUL and lone surrogates. The locale is the profile's or root's empty string.
        let required = unsafe { case(std::ptr::null_mut(), 0, value.as_ptr(), source_len, locale, &mut status) };
        if required < 0 || (status > 0 && status != U_BUFFER_OVERFLOW_ERROR) {
            return Err(Error::Source);
        }
        let length = usize::try_from(required).map_err(|_| Error::Bounds)?;
        if length > MAX_PROBE_UNITS {
            return Err(Error::Bounds);
        }
        // One extra unit permits ICU's terminator, including the empty-string case.
        let capacity = length.checked_add(1).ok_or(Error::Bounds)?;
        let capacity_i32 = i32::try_from(capacity).map_err(|_| Error::Bounds)?;
        let mut output = Vec::new();
        output.try_reserve_exact(capacity).map_err(|_| Error::Bounds)?;
        output.resize(capacity, 0u16);
        status = 0;
        // SAFETY: source and locale are held; output has exactly the advertised capacity and does not overlap the input.
        let written = unsafe {
            case(
                output.as_mut_ptr(),
                capacity_i32,
                value.as_ptr(),
                source_len,
                locale,
                &mut status,
            )
        };
        if status > 0 || written != required {
            return Err(Error::Source);
        }
        output.truncate(length);
        Ok(output)
    }
}

fn validate(profile: &Profile) -> Result<(), Error> {
    if !valid_locale(&profile.locale_id)
        || !valid_locale(&profile.valid_locale)
        || !valid_locale(&profile.actual_locale)
        || profile.attributes[4] != UCOL_ON
        || profile.attributes[5] != UCOL_TERTIARY
        || profile.probes.len() < MIN_PROBES
        || profile.probes.len() > MAX_PROBES
    {
        return Err(Error::Source);
    }
    for probe in &profile.probes {
        if probe.sign < -1 || probe.sign > 1 || probe.left.len() > MAX_PROBE_UNITS || probe.right.len() > MAX_PROBE_UNITS {
            return Err(Error::Bounds);
        }
    }
    Ok(())
}

fn valid_locale(locale: &str) -> bool {
    !locale.is_empty()
        && locale.len() <= MAX_LOCALE_BYTES
        && locale.is_ascii()
        && !locale.bytes().any(|b| b == 0 || b.is_ascii_control())
}

fn sign_of(order: Ordering) -> i8 {
    match order {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

type UStrCase = unsafe extern "C" fn(*mut u16, i32, *const u16, i32, *const c_char, *mut i32) -> i32;

// The ICU 78.2 C API as build.rs links it: static libraries whose symbols carry ICU's own `_78` suffix.
unsafe extern "C" {
    #[link_name = "u_getVersion_78"]
    fn u_get_version(info: *mut u8);
    #[link_name = "u_getDataVersion_78"]
    fn u_get_data_version(info: *mut u8, status: *mut i32);
    #[link_name = "u_strToLower_78"]
    fn u_str_to_lower(dest: *mut u16, dest_capacity: i32, src: *const u16, src_len: i32, locale: *const c_char, status: *mut i32) -> i32;
    #[link_name = "u_strToUpper_78"]
    fn u_str_to_upper(dest: *mut u16, dest_capacity: i32, src: *const u16, src_len: i32, locale: *const c_char, status: *mut i32) -> i32;
    #[link_name = "ucol_open_78"]
    fn ucol_open(locale: *const c_char, status: *mut i32) -> *mut c_void;
    #[link_name = "ucol_close_78"]
    fn ucol_close(collator: *mut c_void);
    #[link_name = "ucol_setAttribute_78"]
    fn ucol_set_attribute(collator: *mut c_void, attribute: i32, value: i32, status: *mut i32);
    #[link_name = "ucol_getAttribute_78"]
    fn ucol_get_attribute(collator: *const c_void, attribute: i32, status: *mut i32) -> i32;
    #[link_name = "ucol_getVersion_78"]
    fn ucol_get_version(collator: *const c_void, info: *mut u8);
    #[link_name = "ucol_getUCAVersion_78"]
    fn ucol_get_uca_version(collator: *const c_void, info: *mut u8);
    #[link_name = "ucol_getLocaleByType_78"]
    fn ucol_get_locale_by_type(collator: *const c_void, kind: i32, status: *mut i32) -> *const c_char;
    #[link_name = "ucol_strcoll_78"]
    fn ucol_strcoll(collator: *const c_void, left: *const u16, left_len: i32, right: *const u16, right_len: i32) -> i32;
}

struct Collator(NonNull<c_void>);
// The handle is used only behind Collation's mutex, and it is closed once, by Drop.
unsafe impl Send for Collator {}
impl Drop for Collator {
    fn drop(&mut self) {
        unsafe {
            ucol_close(self.0.as_ptr());
        }
    }
}

fn set_attribute(collator: &Collator, attribute: i32, value: i32) -> Result<(), Error> {
    let mut status = 0;
    unsafe {
        ucol_set_attribute(collator.0.as_ptr(), attribute, value, &mut status);
    }
    if status > 0 {
        Err(Error::Source)
    } else {
        Ok(())
    }
}

/// The linked ICU's own readback must equal the profile: versions, attributes and locale names.
fn check_metadata(collator: &Collator, profile: &Profile) -> Result<(), Error> {
    let mut icu_version = [0u8; 4];
    let mut data_version = [0u8; 4];
    let mut collator_version = [0u8; 4];
    let mut uca_version = [0u8; 4];
    let mut status = 0;
    unsafe {
        u_get_version(icu_version.as_mut_ptr());
        u_get_data_version(data_version.as_mut_ptr(), &mut status);
        ucol_get_version(collator.0.as_ptr(), collator_version.as_mut_ptr());
        ucol_get_uca_version(collator.0.as_ptr(), uca_version.as_mut_ptr());
    }
    if status > 0 {
        return Err(Error::Source);
    }
    if icu_version != profile.icu_version
        || data_version != profile.data_version
        || collator_version != profile.collator_version
        || uca_version != profile.uca_version
    {
        return Err(Error::Source);
    }
    let mut attributes = [0i32; 7];
    for (slot, attribute) in attributes.iter_mut().zip(ICU_ATTRIBUTES) {
        let mut status = 0;
        *slot = unsafe { ucol_get_attribute(collator.0.as_ptr(), attribute, &mut status) };
        if status > 0 {
            return Err(Error::Source);
        }
    }
    if attributes != profile.attributes
        || locale_string(collator, ULOC_VALID_LOCALE)? != profile.valid_locale
        || locale_string(collator, ULOC_ACTUAL_LOCALE)? != profile.actual_locale
    {
        return Err(Error::Source);
    }
    Ok(())
}

fn locale_string(collator: &Collator, kind: i32) -> Result<String, Error> {
    let mut status = 0;
    let value = unsafe { ucol_get_locale_by_type(collator.0.as_ptr(), kind, &mut status) };
    if status > 0 || value.is_null() {
        return Err(Error::Source);
    }
    let bytes = unsafe { CStr::from_ptr(value) }.to_bytes();
    if bytes.is_empty() || bytes.len() > MAX_LOCALE_BYTES {
        return Err(Error::Source);
    }
    let locale = std::str::from_utf8(bytes).map_err(|_| Error::Source)?.to_owned();
    if !valid_locale(&locale) {
        return Err(Error::Source);
    }
    Ok(locale)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ICU this build linked, for whichever target it was built (the building computer's own, or a cross build
    /// with configure's `--host`, build.rs), matches the engine's profile: versions, locales, attributes and every
    /// original-runtime probe. Run on the target, it proves that target's archives, not the building computer's.
    #[test]
    fn the_linked_icu_matches_the_engine_profile_on_the_computer_it_runs_on() {
        let collation = Collation::engine().expect("the linked ICU matches the engine profile");
        let profile = engine_profile().unwrap();
        assert!(!profile.probes.is_empty());
        for probe in &profile.probes {
            assert_eq!(sign_of(collation.compare(&probe.left, &probe.right).unwrap()), probe.sign);
        }
    }
}
