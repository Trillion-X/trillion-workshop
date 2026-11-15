//! The Lexer (Tokenizer) for the Formula Engine
//!
//! This module implements the tokenization layer that converts raw formula strings
//! into a sequence of tokens for parsing. The lexer provides comprehensive error
//! handling with position tracking, advanced string processing, and robust numeric
//! parsing to ensure exceptional developer experience and security.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// TokenType enum with all language primitives
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TokenType {
    // Literals
    Number(f64),
    String(String),
    Boolean(bool),
    Null,

    // Identifier
    Identifier(String),

    // Operators
    Plus,         // +
    Minus,        // -
    Star,         // *
    Slash,        // /
    Percent,      // %
    Eq,           // ==
    FormulaStart, // leading =
    NotEq,        // !=
    Lt,           // <
    Lte,          // <=
    Gt,           // >
    Gte,          // >=
    And,          // &&
    Or,           // ||
    Not,          // !

    // Delimiters
    LParen,   // (
    RParen,   // )
    LBracket, // [
    RBracket, // ]
    LBrace,   // #{
    RBrace,   // }
    Comma,    // ,
    Dot,      // .
    Colon,    // :
    Pipe,     // |
    Arrow,    // =>

    // Special references
    At,       // @
    DoubleAt, // @@
    Scope,    // $scope

    // End of File
    Eof,
}

/// Position information for error reporting - enables pinpoint debugging
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub line: usize,
    pub column: usize,
    pub offset: usize,
}

impl Position {
    pub fn new(line: usize, column: usize, offset: usize) -> Self {
        Self {
            line,
            column,
            offset,
        }
    }
}

/// Token struct with position tracking for comprehensive error reporting
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Token {
    pub token_type: TokenType,
    pub position: Position,
}

impl Token {
    pub fn new(token_type: TokenType, position: Position) -> Self {
        Self {
            token_type,
            position,
        }
    }
}

/// Comprehensive lexer error types with precise context for debugging
///
/// These errors follow the "Ruthlessly Reduce Cognitive Load" principle by
/// providing exact error locations and actionable context for developers.
#[derive(Error, Debug, PartialEq, Clone)]
pub enum LexerError {
    #[error("Unexpected character: '{character}' at line {line}, column {column}")]
    UnexpectedCharacter {
        character: char,
        line: usize,
        column: usize,
    },

    #[error("Unterminated string literal starting at line {start_line}, column {start_column}")]
    UnterminatedStringLiteral {
        start_line: usize,
        start_column: usize,
    },

    #[error("Unterminated block comment starting at line {start_line}, column {start_column}")]
    UnterminatedBlockComment {
        start_line: usize,
        start_column: usize,
    },

    #[error("Unknown escape sequence '\\{character}' at line {line}, column {column}")]
    UnknownEscapeSequence {
        character: char,
        line: usize,
        column: usize,
    },

    #[error("Invalid number format '{value}' at line {line}, column {column}")]
    InvalidNumberFormat {
        value: String,
        line: usize,
        column: usize,
    },

    #[error("Invalid Unicode escape sequence '\\u{sequence}' at line {line}, column {column} - expected 4 hex digits")]
    InvalidUnicodeEscapeSequence {
        sequence: String,
        line: usize,
        column: usize,
    },
}

/// Production-ready lexer with comprehensive tokenization capabilities
pub struct Lexer<'a> {
    chars: std::iter::Peekable<std::str::Chars<'a>>,
    line: usize,
    column: usize,
    offset: usize,
    finished: bool,
}

impl<'a> Lexer<'a> {
    /// Create a new Lexer for the given input string
    pub fn new(input: &'a str) -> Self {
        Self {
            chars: input.chars().peekable(),
            line: 1,
            column: 1,
            offset: 0,
            finished: false,
        }
    }

    /// Get current position for error reporting
    fn current_position(&self) -> Position {
        Position::new(self.line, self.column, self.offset)
    }

    /// Advance to next character and update position tracking
    fn next_char(&mut self) -> Option<char> {
        if let Some(ch) = self.chars.next() {
            self.offset += 1;
            if ch == '\n' {
                self.line += 1;
                self.column = 1;
            } else {
                self.column += 1;
            }
            Some(ch)
        } else {
            None
        }
    }

    /// Peek at next character without consuming it
    fn peek_char(&mut self) -> Option<&char> {
        self.chars.peek()
    }

    /// Skip whitespace characters and both single-line (//) and block (/* */) comments
    ///
    /// This advanced comment handling ensures clean tokenization while supporting
    /// both comment styles commonly used in programming languages.
    fn skip_whitespace_and_comments(&mut self) {
        loop {
            // Skip whitespace
            while let Some(&ch) = self.peek_char() {
                if ch.is_whitespace() {
                    self.next_char();
                } else {
                    break;
                }
            }

            // Check for comments
            if let Some(&'/') = self.peek_char() {
                // Look ahead for second character
                let mut chars_iter = self.chars.clone();
                chars_iter.next(); // consume first /
                match chars_iter.peek() {
                    Some(&'/') => {
                        // Single-line comment: skip to end of line
                        self.next_char(); // consume first /
                        self.next_char(); // consume second /

                        while let Some(ch) = self.next_char() {
                            if ch == '\n' {
                                break;
                            }
                        }
                        // Continue loop to skip any whitespace after comment
                    }
                    Some(&'*') => {
                        // Block comment: skip to closing */
                        let _start_pos = self.current_position();
                        self.next_char(); // consume first /
                        self.next_char(); // consume *

                        let mut found_end = false;
                        while let Some(ch) = self.next_char() {
                            if ch == '*' && self.peek_char() == Some(&'/') {
                                self.next_char(); // consume closing /
                                found_end = true;
                                break;
                            }
                        }

                        if !found_end {
                            // This will be handled as an error in the main tokenization loop
                            return;
                        }
                        // Continue loop to skip any whitespace after comment
                    }
                    _ => {
                        // Not a comment, break out of loop
                        break;
                    }
                }
            } else {
                // No comment found, break out of loop
                break;
            }
        }
    }

    /// Tokenize a number with comprehensive format support
    ///
    /// Supports integers (123), floats (123.45), and scientific notation (1.23e-4, 6.022E+23).
    /// Provides detailed error messages for malformed numbers to aid debugging.
    fn tokenize_number(&mut self, first_char: char) -> Result<TokenType, LexerError> {
        let start_pos = self.current_position();
        let mut num_str = String::from(first_char);
        let mut has_dot = false;
        let mut has_e = false;

        // Collect digits, decimal point, and scientific notation
        while let Some(&ch) = self.peek_char() {
            match ch {
                '0'..='9' => {
                    num_str.push(self.next_char().unwrap());
                }
                '.' if !has_dot && !has_e => {
                    has_dot = true;
                    num_str.push(self.next_char().unwrap());
                }
                'e' | 'E' if !has_e => {
                    has_e = true;
                    num_str.push(self.next_char().unwrap());

                    // Handle optional + or - after e/E
                    if let Some(&next_ch) = self.peek_char() {
                        if next_ch == '+' || next_ch == '-' {
                            num_str.push(self.next_char().unwrap());
                        }
                    }
                }
                _ => break,
            }
        }

        // Parse the number with detailed error reporting
        num_str
            .parse::<f64>()
            .map(TokenType::Number)
            .map_err(|_| LexerError::InvalidNumberFormat {
                value: num_str,
                line: start_pos.line,
                column: start_pos.column,
            })
    }

    /// Tokenize a string with comprehensive escape sequence support
    ///
    /// Supports standard JSON escape sequences including \n, \t, \r, \\, \", and
    /// Unicode sequences (\uXXXX). Provides specific error messages for unterminated
    /// strings and invalid escape sequences.
    fn tokenize_string(&mut self) -> Result<TokenType, LexerError> {
        let mut string_value = String::new();
        let start_pos = self.current_position();

        while let Some(ch) = self.next_char() {
            match ch {
                '"' => {
                    // End of string
                    return Ok(TokenType::String(string_value));
                }
                '\\' => {
                    // Handle escape sequences
                    if let Some(escaped_char) = self.next_char() {
                        match escaped_char {
                            'n' => string_value.push('\n'),
                            't' => string_value.push('\t'),
                            'r' => string_value.push('\r'),
                            '\\' => string_value.push('\\'),
                            '"' => string_value.push('"'),
                            '\'' => string_value.push('\''),
                            '/' => string_value.push('/'),
                            'b' => string_value.push('\x08'), // backspace
                            'f' => string_value.push('\x0C'), // form feed
                            '0' => string_value.push('\0'),
                            'u' => {
                                // Unicode escape sequence: \uXXXX
                                let mut hex_digits = String::new();
                                for _ in 0..4 {
                                    if let Some(hex_char) = self.next_char() {
                                        if hex_char.is_ascii_hexdigit() {
                                            hex_digits.push(hex_char);
                                        } else {
                                            return Err(LexerError::InvalidUnicodeEscapeSequence {
                                                sequence: format!("u{hex_digits}"),
                                                line: self.line,
                                                column: self.column,
                                            });
                                        }
                                    } else {
                                        return Err(LexerError::UnterminatedStringLiteral {
                                            start_line: start_pos.line,
                                            start_column: start_pos.column,
                                        });
                                    }
                                }

                                // Parse hex digits to Unicode character
                                if let Ok(code_point) = u32::from_str_radix(&hex_digits, 16) {
                                    if let Some(unicode_char) = std::char::from_u32(code_point) {
                                        string_value.push(unicode_char);
                                    } else {
                                        return Err(LexerError::InvalidUnicodeEscapeSequence {
                                            sequence: format!("u{hex_digits}"),
                                            line: self.line,
                                            column: self.column,
                                        });
                                    }
                                } else {
                                    return Err(LexerError::InvalidUnicodeEscapeSequence {
                                        sequence: format!("u{hex_digits}"),
                                        line: self.line,
                                        column: self.column,
                                    });
                                }
                            }
                            _ => {
                                return Err(LexerError::UnknownEscapeSequence {
                                    character: escaped_char,
                                    line: self.line,
                                    column: self.column,
                                });
                            }
                        }
                    } else {
                        // Backslash at end of input
                        return Err(LexerError::UnterminatedStringLiteral {
                            start_line: start_pos.line,
                            start_column: start_pos.column,
                        });
                    }
                }
                _ => {
                    string_value.push(ch);
                }
            }
        }

        // Reached end of input without closing quote
        Err(LexerError::UnterminatedStringLiteral {
            start_line: start_pos.line,
            start_column: start_pos.column,
        })
    }

    /// Tokenize an identifier with keyword recognition
    ///
    /// Recognizes language keywords (true, false, null) and converts them to
    /// appropriate token types, while treating all other valid identifiers
    /// as identifier tokens.
    fn tokenize_identifier(&mut self, first_char: char) -> TokenType {
        let mut identifier = String::from(first_char);

        // Collect alphanumeric characters and underscores
        while let Some(&ch) = self.peek_char() {
            if ch.is_alphanumeric() || ch == '_' {
                identifier.push(self.next_char().unwrap());
            } else {
                break;
            }
        }

        // Check for keywords
        match identifier.as_str() {
            "true" => TokenType::Boolean(true),
            "false" => TokenType::Boolean(false),
            "null" => TokenType::Null,
            _ => TokenType::Identifier(identifier),
        }
    }
}

impl<'a> Iterator for Lexer<'a> {
    type Item = Result<Token, LexerError>;

    fn next(&mut self) -> Option<Self::Item> {
        // If we've already emitted EOF, end the iterator.
        if self.finished {
            return None;
        }

        // Skip whitespace and comments
        self.skip_whitespace_and_comments();

        // Capture position before consuming a char
        let position = self.current_position();

        // If there are no more chars, emit EOF ONCE, then stop next time.
        let ch = match self.next_char() {
            Some(ch) => ch,
            None => {
                self.finished = true;
                return Some(Ok(Token::new(TokenType::Eof, position)));
            }
        };

        let token_result = match ch {
            // Single character tokens
            '+' => Ok(TokenType::Plus),
            '-' => Ok(TokenType::Minus),
            '*' => Ok(TokenType::Star),
            '%' => Ok(TokenType::Percent),
            '(' => Ok(TokenType::LParen),
            ')' => Ok(TokenType::RParen),
            '[' => Ok(TokenType::LBracket),
            ']' => Ok(TokenType::RBracket),
            '}' => Ok(TokenType::RBrace),
            ',' => Ok(TokenType::Comma),
            '.' => Ok(TokenType::Dot),
            ':' => Ok(TokenType::Colon),

            // Multi-character tokens
            '#' => {
                if self.peek_char() == Some(&'{') {
                    self.next_char();
                    Ok(TokenType::LBrace)
                } else {
                    Err(LexerError::UnexpectedCharacter {
                        character: ch,
                        line: position.line,
                        column: position.column,
                    })
                }
            }
            '=' => match self.peek_char() {
                Some(&'=') => {
                    self.next_char();
                    Ok(TokenType::Eq)
                }
                Some(&'>') => {
                    self.next_char();
                    Ok(TokenType::Arrow)
                }
                _ => Ok(TokenType::FormulaStart),
            },
            '!' => {
                if self.peek_char() == Some(&'=') {
                    self.next_char();
                    Ok(TokenType::NotEq)
                } else {
                    Ok(TokenType::Not)
                }
            }
            '<' => {
                if self.peek_char() == Some(&'=') {
                    self.next_char();
                    Ok(TokenType::Lte)
                } else {
                    Ok(TokenType::Lt)
                }
            }
            '>' => {
                if self.peek_char() == Some(&'=') {
                    self.next_char();
                    Ok(TokenType::Gte)
                } else {
                    Ok(TokenType::Gt)
                }
            }
            '&' => {
                if self.peek_char() == Some(&'&') {
                    self.next_char();
                    Ok(TokenType::And)
                } else {
                    Err(LexerError::UnexpectedCharacter {
                        character: ch,
                        line: position.line,
                        column: position.column,
                    })
                }
            }
            '|' => {
                if self.peek_char() == Some(&'|') {
                    self.next_char();
                    Ok(TokenType::Or)
                } else {
                    Ok(TokenType::Pipe)
                }
            }
            '/' => {
                // Check for unterminated block comment
                if self.peek_char() == Some(&'*') {
                    // We found a /* but skip_whitespace_and_comments didn't handle it
                    // This means we have an unterminated block comment
                    return Some(Err(LexerError::UnterminatedBlockComment {
                        start_line: position.line,
                        start_column: position.column,
                    }));
                } else {
                    Ok(TokenType::Slash)
                }
            }

            // Numbers (integers, floats, scientific notation)
            '0'..='9' => self.tokenize_number(ch),

            // String literals with comprehensive escape sequence support
            '"' => self.tokenize_string(),

            // Identifiers and keywords
            ch if ch.is_alphabetic() || ch == '_' => Ok(self.tokenize_identifier(ch)),

            // Special references
            '@' => {
                if self.peek_char() == Some(&'@') {
                    self.next_char();
                    Ok(TokenType::DoubleAt)
                } else {
                    Ok(TokenType::At)
                }
            }
            '$' => {
                // Peek ahead without consuming to check for "scope"
                let remaining: String = self.chars.clone().collect();
                if remaining.starts_with("scope") {
                    // It's a match, so now we consume the scope-name characters.
                    for _ in 0.."scope".len() {
                        self.next_char();
                    }
                    Ok(TokenType::Scope)
                } else {
                    Err(LexerError::UnexpectedCharacter {
                        character: ch,
                        line: position.line,
                        column: position.column,
                    })
                }
            }

            // Unexpected characters
            _ => Err(LexerError::UnexpectedCharacter {
                character: ch,
                line: position.line,
                column: position.column,
            }),
        };

        Some(token_result.map(|token_type| Token::new(token_type, position)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scientific_notation() {
        let mut lexer = Lexer::new("1e10 1.23E-4 5e+2");

        assert_eq!(
            lexer.next().unwrap().unwrap().token_type,
            TokenType::Number(1e10)
        );
        assert_eq!(
            lexer.next().unwrap().unwrap().token_type,
            TokenType::Number(1.23e-4)
        );
        assert_eq!(
            lexer.next().unwrap().unwrap().token_type,
            TokenType::Number(5e2)
        );
    }

    #[test]
    fn test_string_escapes() {
        let mut lexer = Lexer::new(
            r#""Hello\nWorld" "Quote: \"Hi\"" "Unicode: \u0048\u0065\u006C\u006C\u006F""#,
        );

        if let TokenType::String(s) = lexer.next().unwrap().unwrap().token_type {
            assert_eq!(s, "Hello\nWorld");
        }

        if let TokenType::String(s) = lexer.next().unwrap().unwrap().token_type {
            assert_eq!(s, "Quote: \"Hi\"");
        }

        if let TokenType::String(s) = lexer.next().unwrap().unwrap().token_type {
            assert_eq!(s, "Unicode: Hello");
        }
    }

    #[test]
    fn test_comments() {
        let mut lexer = Lexer::new("1 + 2 // line comment\n3 /* block comment */ 4");

        assert_eq!(
            lexer.next().unwrap().unwrap().token_type,
            TokenType::Number(1.0)
        );
        assert_eq!(lexer.next().unwrap().unwrap().token_type, TokenType::Plus);
        assert_eq!(
            lexer.next().unwrap().unwrap().token_type,
            TokenType::Number(2.0)
        );
        assert_eq!(
            lexer.next().unwrap().unwrap().token_type,
            TokenType::Number(3.0)
        );
        assert_eq!(
            lexer.next().unwrap().unwrap().token_type,
            TokenType::Number(4.0)
        );
    }

    #[test]
    fn test_special_references() {
        let mut lexer = Lexer::new("@ @@ $scope");

        // Test @ token
        assert_eq!(lexer.next().unwrap().unwrap().token_type, TokenType::At);

        // Test @@ token
        assert_eq!(
            lexer.next().unwrap().unwrap().token_type,
            TokenType::DoubleAt
        );

        // Test $scope token
        assert_eq!(lexer.next().unwrap().unwrap().token_type, TokenType::Scope);
    }

    #[test]
    fn test_error_positions() {
        let mut lexer = Lexer::new("valid $invalid");

        // First token should be valid
        assert!(lexer.next().unwrap().is_ok());

        // Second token should be an error with position ($ without scope)
        if let Err(LexerError::UnexpectedCharacter {
            character,
            line,
            column,
        }) = lexer.next().unwrap()
        {
            assert_eq!(character, '$');
            assert_eq!(line, 1);
            assert_eq!(column, 7);
        } else {
            panic!("Expected UnexpectedCharacter error");
        }
    }
}
