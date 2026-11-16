//! Portable DATA contract for process-workspace execution bindings.
//!
//! These values describe how an owner resolves host-private workspace paths
//! only after a portable process request has been admitted. The execution
//! owner performs resolution; this crate owns the serialized ABI.

use crate::{normalize_process_path_segments, ExecutionError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// One ordered component of a host-private environment value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessWorkspaceEnvironmentValuePart {
    /// Exact host-private text. NUL is forbidden.
    Literal { value: String },
    /// The owner-held absolute workspace root.
    WorkspaceRoot,
    /// One absolute path beneath the workspace root, expressed portably.
    WorkspacePath { segments: Vec<String> },
    /// The exact request-hash-bound value of one portable environment key.
    /// It may appear exactly once and only in a binding replacing that key.
    PortableEnvironmentValue { key: String },
    /// The owner-held absolute root of one private volume this process declared
    /// in `readable_private_volumes`, optionally descended by fixed portable
    /// segments.
    ///
    /// Writing a private volume is exclusive because two writers would overwrite
    /// each other. Reading one is not, and welding the two together left every
    /// durable byte a resident writer produced unreachable by anything else. This
    /// part is how a reader learns where to look without package DATA ever naming
    /// a host path.
    ReadablePrivateVolumeRoot {
        name: String,
        #[serde(default)]
        segments: Vec<String>,
    },
}

/// One exact environment binding resolved only after workspace admission.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessWorkspaceEnvironmentBinding {
    pub key: String,
    pub parts: Vec<ProcessWorkspaceEnvironmentValuePart>,
}

/// One host-private environment value a runtime needs in order to function,
/// expressed only against that runtime's own admitted artifacts.
///
/// Package DATA never names a host-private path, and the engine never learns
/// the name of any particular runtime: a runtime whose standard library lives
/// beside its executable declares that fact here, and a runtime that needs
/// nothing declares nothing. Adding such a runtime is DATA, never engine code.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessRuntimeEnvironmentValue {
    /// Exact portable text owned by the runtime binding.
    Literal { value: String },
    /// One readable root of this same runtime binding, by declaration order,
    /// optionally descended by fixed portable segments.
    ReadableRootPath {
        readable_root_index: usize,
        #[serde(default)]
        segments: Vec<String>,
    },
    /// The directory holding this runtime's admitted executable, optionally
    /// descended by fixed portable segments.
    ExecutableDirectory {
        #[serde(default)]
        segments: Vec<String>,
    },
    /// The current operating-system user's home, available only to a runtime
    /// whose binding grants full computer access.
    CurrentUserHome {
        #[serde(default)]
        segments: Vec<String>,
    },
    /// One named value the DEPLOYMENT supplied to the process that admits this
    /// runtime, passed through by name.
    ///
    /// WHY THIS EXISTS, and why it is not ambient authority. A secret a hosting
    /// provider holds reaches a machine as an environment variable and in no
    /// other way. Every other kind here resolves against artifacts the runtime
    /// already owns, so a deployment-provided secret had no road to a contained
    /// child at all: the authority execs with exactly this map, nothing is
    /// inherited, and the value cannot be a `Literal` because that writes a live
    /// credential into package DATA and into version control.
    ///
    /// It stays narrow on purpose. One NAME per entry, declared in the role and
    /// reviewed like any other DATA, with no wildcard and no prefix match, so a
    /// reader of the role sees exactly which deployment values a runtime can
    /// observe. The engine still learns nothing about what the value means.
    DeploymentEnvironment { name: String },
}

/// One ordered component of a host-private process argument.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessWorkspaceArgumentValuePart {
    /// Exact portable text. NUL is forbidden.
    Literal { value: String },
    /// The owner-held absolute workspace root.
    WorkspaceRoot,
    /// One absolute path beneath the workspace root, expressed portably.
    WorkspacePath { segments: Vec<String> },
}

/// One exact argv binding resolved only after workspace admission.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessWorkspaceArgumentBinding {
    /// Index in the portable argv. Index zero is the runtime-selector
    /// authority and can never be replaced by a workspace binding.
    pub index: usize,
    pub parts: Vec<ProcessWorkspaceArgumentValuePart>,
}

/// Host-private environment bindings for one prepared-workspace execution.
///
/// The portable request never contains an owner root. Ordered value parts are
/// resolved during admission and only the resolved environment enters the
/// admitted descriptor and its receipt hash.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessWorkspaceExecutionBindings {
    #[serde(default)]
    pub environment: Vec<ProcessWorkspaceEnvironmentBinding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<ProcessWorkspaceArgumentBinding>,
}

impl ProcessWorkspaceExecutionBindings {
    pub fn try_new(
        environment: Vec<ProcessWorkspaceEnvironmentBinding>,
    ) -> Result<Self, ExecutionError> {
        let bindings = Self {
            environment,
            arguments: Vec::new(),
        };
        bindings.validate()?;
        Ok(bindings)
    }

    pub fn try_new_with_arguments(
        environment: Vec<ProcessWorkspaceEnvironmentBinding>,
        arguments: Vec<ProcessWorkspaceArgumentBinding>,
    ) -> Result<Self, ExecutionError> {
        let bindings = Self {
            environment,
            arguments,
        };
        bindings.validate()?;
        Ok(bindings)
    }

    /// Strictly decode host-private binding DATA without accepting extensions.
    pub fn from_json(bytes: &[u8]) -> Result<Self, ExecutionError> {
        let bindings: Self =
            serde_json::from_slice(bytes).map_err(|error| ExecutionError::InvalidDescriptor {
                field: "process_workspace_execution_bindings".into(),
                reason: format!("strict JSON decode failed: {error}"),
            })?;
        bindings.validate()?;
        Ok(bindings)
    }

    pub fn validate(&self) -> Result<(), ExecutionError> {
        let mut keys = BTreeSet::new();
        for binding in &self.environment {
            if binding.key.is_empty()
                || binding.key.contains('=')
                || binding.key.as_bytes().contains(&0)
            {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "workspace_bindings.environment[].key".into(),
                    reason: "keys must be nonempty, NUL-free, and contain no '='".into(),
                });
            }
            if !keys.insert(binding.key.as_str()) {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "workspace_bindings.environment[].key".into(),
                    reason: format!("duplicate environment key: {}", binding.key),
                });
            }
            if binding.parts.is_empty() {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "workspace_bindings.environment[].parts".into(),
                    reason: "at least one ordered value part is required".into(),
                });
            }
            let mut portable_value_parts = 0_usize;
            for part in &binding.parts {
                match part {
                    ProcessWorkspaceEnvironmentValuePart::Literal { value }
                        if value.as_bytes().contains(&0) =>
                    {
                        return Err(ExecutionError::InvalidDescriptor {
                            field: "workspace_bindings.environment[].parts[].value".into(),
                            reason: "literal values must be NUL-free".into(),
                        });
                    }
                    ProcessWorkspaceEnvironmentValuePart::WorkspacePath { segments } => {
                        normalize_process_path_segments(
                            "workspace_bindings.environment[].parts[].segments",
                            segments,
                        )?;
                    }
                    ProcessWorkspaceEnvironmentValuePart::PortableEnvironmentValue { key } => {
                        if key != &binding.key {
                            return Err(ExecutionError::InvalidDescriptor {
                                field: "workspace_bindings.environment[].parts[].key".into(),
                                reason:
                                    "portable value references must name their own replacement key"
                                        .into(),
                            });
                        }
                        portable_value_parts += 1;
                        if portable_value_parts > 1 {
                            return Err(ExecutionError::InvalidDescriptor {
                                field: "workspace_bindings.environment[].parts".into(),
                                reason:
                                    "a portable environment value may be referenced exactly once"
                                        .into(),
                            });
                        }
                    }
                    ProcessWorkspaceEnvironmentValuePart::ReadablePrivateVolumeRoot {
                        name,
                        segments,
                    } => {
                        if name.is_empty() {
                            return Err(ExecutionError::InvalidDescriptor {
                                field: "workspace_bindings.environment[].parts[].name".into(),
                                reason: "readable private volume name must be nonempty".into(),
                            });
                        }
                        if !segments.is_empty() {
                            normalize_process_path_segments(
                                "workspace_bindings.environment[].parts[].segments",
                                segments,
                            )?;
                        }
                    }
                    ProcessWorkspaceEnvironmentValuePart::Literal { .. }
                    | ProcessWorkspaceEnvironmentValuePart::WorkspaceRoot => {}
                }
            }
        }
        let mut argument_indexes = BTreeSet::new();
        for binding in &self.arguments {
            if binding.index == 0 {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "workspace_bindings.arguments[].index".into(),
                    reason: "argv[0] is the admitted runtime-selector authority".into(),
                });
            }
            if !argument_indexes.insert(binding.index) {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "workspace_bindings.arguments[].index".into(),
                    reason: format!("duplicate argument index: {}", binding.index),
                });
            }
            if binding.parts.is_empty() {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "workspace_bindings.arguments[].parts".into(),
                    reason: "at least one ordered value part is required".into(),
                });
            }
            for part in &binding.parts {
                match part {
                    ProcessWorkspaceArgumentValuePart::Literal { value }
                        if value.as_bytes().contains(&0) =>
                    {
                        return Err(ExecutionError::InvalidDescriptor {
                            field: "workspace_bindings.arguments[].parts[].value".into(),
                            reason: "literal values must be NUL-free".into(),
                        });
                    }
                    ProcessWorkspaceArgumentValuePart::WorkspacePath { segments } => {
                        normalize_process_path_segments(
                            "workspace_bindings.arguments[].parts[].segments",
                            segments,
                        )?;
                    }
                    ProcessWorkspaceArgumentValuePart::Literal { .. }
                    | ProcessWorkspaceArgumentValuePart::WorkspaceRoot => {}
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deployment_environment_binding_has_one_exact_named_shape() {
        let value: ProcessRuntimeEnvironmentValue = serde_json::from_slice(
            br#"{"kind":"deployment_environment","name":"ANTHROPIC_API_KEY"}"#,
        )
        .expect("decode named deployment environment binding");
        assert_eq!(
            value,
            ProcessRuntimeEnvironmentValue::DeploymentEnvironment {
                name: "ANTHROPIC_API_KEY".into(),
            }
        );
        assert_eq!(
            serde_json::to_vec(&value).expect("encode named deployment environment binding"),
            br#"{"kind":"deployment_environment","name":"ANTHROPIC_API_KEY"}"#
        );

        assert!(serde_json::from_slice::<ProcessRuntimeEnvironmentValue>(
            br#"{"kind":"deployment_environment","name":"ANTHROPIC_API_KEY","prefix":"unsafe"}"#,
        )
        .is_err());
    }

    #[test]
    fn rejects_duplicates_nul_traversal_and_unknown_fields() {
        let duplicate = ProcessWorkspaceExecutionBindings::try_new(vec![
            ProcessWorkspaceEnvironmentBinding {
                key: "X".into(),
                parts: vec![ProcessWorkspaceEnvironmentValuePart::WorkspaceRoot],
            },
            ProcessWorkspaceEnvironmentBinding {
                key: "X".into(),
                parts: vec![ProcessWorkspaceEnvironmentValuePart::Literal { value: "x".into() }],
            },
        ]);
        assert!(duplicate.is_err());

        let nul =
            ProcessWorkspaceExecutionBindings::try_new(vec![ProcessWorkspaceEnvironmentBinding {
                key: "X".into(),
                parts: vec![ProcessWorkspaceEnvironmentValuePart::Literal {
                    value: "bad\0value".into(),
                }],
            }]);
        assert!(nul.is_err());

        let traversal =
            ProcessWorkspaceExecutionBindings::try_new(vec![ProcessWorkspaceEnvironmentBinding {
                key: "X".into(),
                parts: vec![ProcessWorkspaceEnvironmentValuePart::WorkspacePath {
                    segments: vec!["..".into()],
                }],
            }]);
        assert!(traversal.is_err());

        assert!(ProcessWorkspaceExecutionBindings::from_json(
            br#"{"environment":[],"unknown":true}"#
        )
        .is_err());

        assert!(ProcessWorkspaceExecutionBindings::try_new_with_arguments(
            Vec::new(),
            vec![ProcessWorkspaceArgumentBinding {
                index: 0,
                parts: vec![ProcessWorkspaceArgumentValuePart::WorkspaceRoot],
            }],
        )
        .is_err());
    }
}
