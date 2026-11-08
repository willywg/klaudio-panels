//! Regression check for the Windows unit-test executable's activation context.

use std::ffi::c_void;

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> *mut c_void;
    fn FindResourceW(module: *mut c_void, name: *const u16, kind: *const u16) -> *mut c_void;
    fn LoadResource(module: *mut c_void, resource: *mut c_void) -> *mut c_void;
    fn LockResource(resource: *mut c_void) -> *const u8;
    fn SizeofResource(module: *mut c_void, resource: *mut c_void) -> u32;
}

#[test]
fn windows_test_executable_embeds_common_controls_v6_manifest() {
    // These handles refer only to resources embedded in this running executable.
    unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        let resource = FindResourceW(
            module,
            std::ptr::without_provenance::<u16>(1),
            std::ptr::without_provenance::<u16>(24),
        );
        assert!(
            !resource.is_null(),
            "the test executable needs an embedded application manifest"
        );
        let data = LockResource(LoadResource(module, resource));
        assert!(!data.is_null());
        let bytes = std::slice::from_raw_parts(data, SizeofResource(module, resource) as usize);
        let manifest = std::str::from_utf8(bytes).unwrap();
        assert!(manifest.contains("Microsoft.Windows.Common-Controls"));
        assert!(manifest.contains("6.0.0.0"));
    }
}
