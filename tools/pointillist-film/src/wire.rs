//! crates/pointillist-film-core/src/wire.rs
//!
//! Deterministic little-endian packed frame encoding.

use crate::config::FilmConfig;
use crate::frame::{PackedCell, PackedCellFrame};
use crate::palette::Rgba8;
use crate::validation::{FilmError, FilmResult};

const WIRE_MAGIC: &[u8; 4] = b"PFCF";
const WIRE_VERSION: u16 = 1;
const HEADER_BYTES: usize = 4 + 2 + 4 + 4 + 4 + 4;
const CELL_BYTES: usize = 4 + 4 + 4 + 4;

pub fn encode_frame(frame: &PackedCellFrame, config: &FilmConfig) -> FilmResult<Vec<u8>> {
    frame.validate(config)?;
    let encoded_len = HEADER_BYTES + frame.cells.len() * CELL_BYTES;
    if encoded_len > config.limits.max_frame_bytes {
        return Err(FilmError::EncodedFrameTooLarge {
            actual: encoded_len,
            max: config.limits.max_frame_bytes,
        });
    }

    let mut out = Vec::with_capacity(encoded_len);
    out.extend_from_slice(WIRE_MAGIC);
    out.extend_from_slice(&WIRE_VERSION.to_le_bytes());
    out.extend_from_slice(&frame.columns.to_le_bytes());
    out.extend_from_slice(&frame.rows.to_le_bytes());
    out.extend_from_slice(&frame.time_seconds.to_le_bytes());
    out.extend_from_slice(&(frame.cells.len() as u32).to_le_bytes());

    for cell in &frame.cells {
        out.extend_from_slice(&cell.cell_id.to_le_bytes());
        out.extend_from_slice(&[cell.color.r, cell.color.g, cell.color.b, cell.color.a]);
        out.extend_from_slice(&cell.opacity.to_le_bytes());
        out.extend_from_slice(&cell.scale.to_le_bytes());
    }
    Ok(out)
}

pub fn decode_frame(bytes: &[u8], config: &FilmConfig) -> FilmResult<PackedCellFrame> {
    if bytes.len() < HEADER_BYTES {
        return Err(FilmError::WireTooShort);
    }
    let mut cursor = Cursor::new(bytes);
    let magic = cursor.read_array::<4>()?;
    if &magic != WIRE_MAGIC {
        return Err(FilmError::WireMagicMismatch);
    }
    let version = cursor.read_u16()?;
    if version != WIRE_VERSION {
        return Err(FilmError::UnsupportedWireVersion(version));
    }
    let columns = cursor.read_u32()?;
    let rows = cursor.read_u32()?;
    let time_seconds = cursor.read_f32()?;
    let cell_count = cursor.read_u32()? as usize;
    let mut cells = Vec::with_capacity(cell_count);

    for _ in 0..cell_count {
        cells.push(PackedCell {
            cell_id: cursor.read_u32()?,
            color: {
                let rgba = cursor.read_array::<4>()?;
                Rgba8::new(rgba[0], rgba[1], rgba[2], rgba[3])
            },
            opacity: cursor.read_f32()?,
            scale: cursor.read_f32()?,
        });
    }

    if cursor.remaining() != 0 {
        return Err(FilmError::WireTrailingBytes(cursor.remaining()));
    }

    let frame = PackedCellFrame {
        columns,
        rows,
        time_seconds,
        cells,
    };
    frame.validate(config)?;
    Ok(frame)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }

    fn read_array<const N: usize>(&mut self) -> FilmResult<[u8; N]> {
        if self.remaining() < N {
            return Err(FilmError::WireTooShort);
        }
        let mut out = [0; N];
        out.copy_from_slice(&self.bytes[self.offset..self.offset + N]);
        self.offset += N;
        Ok(out)
    }

    fn read_u16(&mut self) -> FilmResult<u16> {
        Ok(u16::from_le_bytes(self.read_array::<2>()?))
    }

    fn read_u32(&mut self) -> FilmResult<u32> {
        Ok(u32::from_le_bytes(self.read_array::<4>()?))
    }

    fn read_f32(&mut self) -> FilmResult<f32> {
        Ok(f32::from_le_bytes(self.read_array::<4>()?))
    }
}
