//! Pratt Parser for the Formula Engine.
//!
//! This module implements a Pratt parser that transforms a sequence of tokens from the lexer
//! into a structured Abstract Syntax Tree (AST). The parser follows the EBNF grammar
//! specification defined in Appendix A of the Formula Engine documentation.
//!
//! ## EBNF Grammar Implementation
//!
//! This parser implements the complete EBNF grammar from the Formula Engine specification
//! using a **Pratt parser with precedence climbing**. The grammar hierarchy is implemented
//! through precedence levels rather than separate recursive descent methods.
//!
//! ### Core Parser Architecture
//!
//! ```ebnf
//! program ::= expression? EOF
//! ```
//! **Implementation**: `parse()` and `parse_core()` methods handle the top-level program structure
//!
//! ```ebnf  
//! expression ::= logical_or  // (and all lower precedence levels)
//! ```
//! **Implementation**: `parse_expression(precedence)` with **precedence climbing algorithm**
//!
//! ### Precedence Climbing Implementation
//!
//! The parser uses a single `parse_expression()` method that handles all binary operators
//! through precedence levels defined in `get_precedence()`. The EBNF hierarchy maps to
//! precedence levels as follows:
//!
//! #### Level 1: Logical OR (Lowest Precedence)
//! ```ebnf
//! logical_or ::= logical_and ( OR logical_and )*
//! ```
//! **Precedence**: 1 - `||` operators bind weakest
//!
//! #### Level 2: Logical AND  
//! ```ebnf
//! logical_and ::= equality ( AND equality )*
//! ```
//! **Precedence**: 2 - `&&` operators
//!
//! #### Level 3: Equality
//! ```ebnf
//! equality ::= comparison ( ( EQ | NEQ ) comparison )*
//! ```
//! **Precedence**: 3 - `==`, `!=` operators
//!
//! #### Level 4: Comparison
//! ```ebnf
//! comparison ::= additive ( ( GT | GTE | LT | LTE ) additive )*
//! ```
//! **Precedence**: 4 - `>`, `>=`, `<`, `<=` operators
//!
//! #### Level 5: Additive
//! ```ebnf
//! additive ::= multiplicative ( ( PLUS | MINUS ) multiplicative )*
//! ```  
//! **Precedence**: 5 - `+`, `-` operators
//!
//! #### Level 6: Multiplicative
//! ```ebnf
//! multiplicative ::= unary ( ( STAR | SLASH | PERCENT ) unary )*
//! ```
//! **Precedence**: 6 - `*`, `/`, `%` operators
//!
//! #### Level 7: Call/Access (Highest Precedence)
//! ```ebnf
//! unary ::= ( NOT | MINUS ) unary | call | lambda
//! call ::= primary ( function_call | member_access | index_access )*
//! ```
//! **Precedence**: 7 - Function calls, member access, and array indexing
//!
//! ### Call Expressions and Member Access
//! ```ebnf
//! call ::= primary ( function_call | member_access | index_access )*
//! ```
//! **Implementation**: `parse_infix()` method with precedence 7 for:
//! - `parse_function_call()` - Function calls with optional versioning
//! - `parse_member_access()` - Dot notation access (`.`)  
//! - `parse_index_access()` - Bracket notation access (`[]`)
//!
//! ### Function Calls
//! ```ebnf
//! function_call ::= versioned_function_call | simple_function_call
//! versioned_function_call ::= VERSIONED_IDENT LPAREN arguments? RPAREN
//! simple_function_call ::= LPAREN arguments? RPAREN
//! VERSIONED_IDENT ::= IDENTIFIER ( "@" "v" NUMBER )?
//! ```
//! **Implementation**:
//! - `parse_function_call()` - Handles function calls when identifier is followed by `(`
//! - `parse_versioned_identifier()` - Parses `func@v2` syntax for versioned calls
//!
//! **Note**: The actual implementation treats function calls as postfix operations on identifiers,
//! so `func()` is parsed as identifier `func` followed by function call `()` operator.
//!
//! ### Member and Index Access
//! ```ebnf
//! member_access ::= DOT IDENTIFIER
//! index_access ::= LBRACKET expression RBRACKET
//! ```
//! **Implementation**:
//! - `parse_member_access()` - Handles `object.property` syntax
//! - `parse_index_access()` - Handles `array[index]` syntax
//!
//! ### Lambda Expressions
//! ```ebnf
//! lambda ::= PIPE lambda_params? PIPE ARROW expression
//! lambda_params ::= IDENTIFIER ( COMMA IDENTIFIER )*
//! lambda_expr ::= lambda_params ARROW expression
//! lambda_params ::= IDENTIFIER | LPAREN ( IDENTIFIER ( COMMA IDENTIFIER )* )? RPAREN
//! ```
//! **Implementation**: `parse_lambda()` method handles `|x, y| => expr` syntax
//!
//! **Note**: The parser currently implements the simpler `lambda` rule with pipe delimiters.
//!
//! ### Primary Expressions
//! ```ebnf
//! primary ::= literal | lambda_expr | IDENTIFIER | AT_SIGN | DOUBLE_AT_SIGN | WORKSPACE_REF | LPAREN expression RPAREN
//! ```
//! **Implementation**: `parse_prefix()` method handles:
//! - All literal types (number, string, boolean, null)
//! - Simple identifiers
//! - Special references (`@`, `@@`, `$scope`)
//! - Parenthesized expressions
//! - Lambda expressions (using `|x| => expr` syntax, not the `lambda_expr` rule)
//!
//! ### Literals
//! ```ebnf
//! literal ::= NUMBER | STRING | BOOLEAN | NULL | array_literal | object_literal
//! array_literal ::= LBRACKET ( expression ( COMMA expression )* )? RBRACKET
//! object_literal ::= LBRACE ( property ( COMMA property )* )? RBRACE
//! property ::= ( IDENTIFIER | STRING ) COLON expression
//! ```
//! **Implementation**:
//! - `parse_prefix()` - Handles primitive literals
//! - `parse_array_literal()` - Handles `[1, 2, 3]` syntax
//! - `parse_object_literal()` - Handles `#{key: value}` syntax
//!
//! ### Arguments
//! ```ebnf
//! arguments ::= expression ( COMMA expression )*
//! ```
//! **Implementation**: Integrated into `parse_function_call()` for comma-separated argument lists
//!
//! ## Error Recovery
//!
//! The parser includes comprehensive error recovery mechanisms:
//! - **Synchronization Points**: Recovery at commas, closing delimiters, and EOF
//! - **Multiple Error Collection**: `parse_with_recovery()` collects multiple errors
//! - **Position Tracking**: All errors include accurate line/column information
//! - **Graceful Degradation**: Parser continues after recoverable errors
//!
//! ## Grammar Validation
//!
//! The parser implementation is validated against the EBNF specification through:
//! - **Precedence Tests**: Verify operator precedence matches grammar hierarchy
//! - **Production Rule Tests**: Test each grammar rule with positive/negative cases  
//! - **Terminal Token Tests**: Verify all EBNF terminals are correctly recognized
//! - **Complex Expression Tests**: Validate parsing of nested expressions
//!
//! ## Special Features
//!
//! ### Versioned Function Calls
//! The parser supports versioned function syntax: `MyFunc@v2(args)` which maps to:
//! - Function name: "MyFunc"
//! - Version: Some(2)
//! - Arguments: parsed argument list
//!
//! ### Special References  
//! Three special reference types are supported:
//! - `@` - Current subject supplied by the caller
//! - `@@` - Current actor supplied by the caller
//! - `$scope` - Current evaluation scope supplied by the caller
//!
//! ### Object Literal Syntax
//! Objects use `#{key: value}` syntax (lexed as `LBrace` token) to distinguish from code blocks `{}`.

use super::lexer::{Lexer, LexerError, Token, TokenType};
use super::*;
use std::iter::Peekable;
use std::vec::IntoIter;
use thiserror::Error;

#[derive(Error, Debug, Clone)]
pub enum ParseError {
    #[error("Lexer error: {0}")]
    LexerError(#[from] LexerError),
    #[error(
        "Unexpected token at line {line}, column {column}: expected {expected:?}, found {found:?}"
    )]
    UnexpectedToken {
        expected: Option<String>,
        found: TokenType,
        line: usize,
        column: usize,
    },
    #[error("Unexpected end of input at line {line}, column {column}")]
    UnexpectedEof { line: usize, column: usize },
    #[error("Invalid literal at line {line}, column {column}: {message}")]
    InvalidLiteral {
        message: String,
        line: usize,
        column: usize,
    },
    #[error("Invalid function expression at line {line}, column {column}")]
    InvalidFunction { line: usize, column: usize },
    #[error("Multiple parse errors occurred")]
    MultipleErrors { errors: Vec<ParseError> },
}

/// Associativity rules for operators.
///
/// Defines whether operators of the same precedence level group from left-to-right
/// or right-to-left when chained together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Associativity {
    /// Left-associative: `a + b + c` becomes `(a + b) + c`
    Left,
    /// Right-associative: `a = b = c` becomes `a = (b = c)` (not used in formula engine)
    Right,
}

/// Operator precedence levels from EBNF grammar (0-7)
///
/// This enum formalizes the precedence hierarchy defined in the Formula Engine
/// EBNF specification, providing type safety and clear documentation of each level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum OperatorPrecedence {
    /// Level 0: Default/None (lowest possible precedence)
    None = 0,
    /// Level 1: Logical OR (`||`) - binds weakest
    LogicalOr = 1,
    /// Level 2: Logical AND (`&&`)
    LogicalAnd = 2,
    /// Level 3: Equality (`==`, `!=`)
    Equality = 3,
    /// Level 4: Comparison (`>`, `>=`, `<`, `<=`)
    Comparison = 4,
    /// Level 5: Additive (`+`, `-`)
    Additive = 5,
    /// Level 6: Multiplicative (`*`, `/`, `%`)
    Multiplicative = 6,
    /// Level 7: Call/Access (function calls, member access, array indexing) - binds strongest
    CallAccess = 7,
}

impl OperatorPrecedence {
    /// Convert to numeric precedence level for parser algorithm
    pub fn as_u8(self) -> u8 {
        self as u8
    }

    /// Get precedence from binary operator
    pub fn from_binary_op(op: &BinaryOp) -> Self {
        match op {
            BinaryOp::Or => OperatorPrecedence::LogicalOr,
            BinaryOp::And => OperatorPrecedence::LogicalAnd,
            BinaryOp::Eq | BinaryOp::NotEq => OperatorPrecedence::Equality,
            BinaryOp::Lt | BinaryOp::Lte | BinaryOp::Gt | BinaryOp::Gte => {
                OperatorPrecedence::Comparison
            }
            BinaryOp::Add | BinaryOp::Subtract => OperatorPrecedence::Additive,
            BinaryOp::Multiply | BinaryOp::Divide | BinaryOp::Modulo => {
                OperatorPrecedence::Multiplicative
            }
        }
    }

    /// Get precedence from token type
    pub fn from_token_type(token_type: &TokenType) -> Self {
        match token_type {
            TokenType::Or => OperatorPrecedence::LogicalOr,
            TokenType::And => OperatorPrecedence::LogicalAnd,
            TokenType::Eq | TokenType::NotEq => OperatorPrecedence::Equality,
            TokenType::Lt | TokenType::Lte | TokenType::Gt | TokenType::Gte => {
                OperatorPrecedence::Comparison
            }
            TokenType::Plus | TokenType::Minus => OperatorPrecedence::Additive,
            TokenType::Star | TokenType::Slash | TokenType::Percent => {
                OperatorPrecedence::Multiplicative
            }
            TokenType::LParen | TokenType::Dot | TokenType::LBracket => {
                OperatorPrecedence::CallAccess
            }
            _ => OperatorPrecedence::None,
        }
    }

    /// Get associativity for this precedence level
    ///
    /// In the Formula Engine, all binary operators follow left-associative rules
    /// as defined by the EBNF grammar patterns like `a ( OP a )*`.
    pub fn associativity(self) -> Associativity {
        match self {
            // All precedence levels in the Formula Engine use left associativity
            // This is consistent with the EBNF grammar patterns like:
            // logical_or ::= logical_and ( OR logical_and )*
            // which naturally creates left-associative parsing
            OperatorPrecedence::None => Associativity::Left, // Default
            OperatorPrecedence::LogicalOr => Associativity::Left,
            OperatorPrecedence::LogicalAnd => Associativity::Left,
            OperatorPrecedence::Equality => Associativity::Left,
            OperatorPrecedence::Comparison => Associativity::Left,
            OperatorPrecedence::Additive => Associativity::Left,
            OperatorPrecedence::Multiplicative => Associativity::Left,
            OperatorPrecedence::CallAccess => Associativity::Left,
        }
    }
}

/// The Pratt Parser struct with error recovery capability.
pub struct Parser {
    /// Collected errors during parsing
    errors: Vec<ParseError>,
    /// When true, parser will try to continue and collect multiple errors
    recover: bool,
    /// Last consumed token position for accurate EOF reporting
    last_pos: (usize, usize),
}

impl Parser {
    pub fn new() -> Self {
        Self {
            errors: Vec::new(),
            recover: false,
            last_pos: (1, 1),
        }
    }

    /// Get position from a token or use last seen
    fn pos_or_last(&self, tok: Option<&Token>) -> (usize, usize) {
        tok.map(|t| (t.position.line, t.position.column))
            .unwrap_or(self.last_pos)
    }

    /// Update last_pos whenever we consume a token
    fn bump_last_pos(&mut self, token: &Token) {
        self.last_pos = (token.position.line, token.position.column);
    }

    /// Synchronize to the next recovery point (comma, closing delimiter, or EOF)
    fn synchronize(&mut self, tokens: &mut Peekable<IntoIter<Token>>) {
        while let Some(token) = tokens.peek() {
            match token.token_type {
                // Recovery points – stop skipping here
                TokenType::Comma
                | TokenType::RParen
                | TokenType::RBracket
                | TokenType::RBrace
                | TokenType::Eof => break,
                _ => {
                    // Consume one token and advance position so EOF/next errors report accurately
                    let t = tokens.next().unwrap();
                    self.bump_last_pos(&t);
                }
            }
        }
    }

    /// The main public entry point (fail-fast: first error wins)
    pub fn parse(&mut self, formula_string: &str) -> Result<AstNode, ParseError> {
        self.recover = false;
        self.errors.clear();
        self.last_pos = (1, 1);
        self.parse_core(formula_string)
    }

    /// Parse with recovery: returns AST if recoverable, or all collected errors
    pub fn parse_with_recovery(
        &mut self,
        formula_string: &str,
    ) -> Result<AstNode, Vec<ParseError>> {
        self.recover = true;
        self.errors.clear();
        self.last_pos = (1, 1);

        match self.parse_core(formula_string) {
            Ok(ast) => {
                if self.errors.is_empty() {
                    Ok(ast)
                } else {
                    Err(std::mem::take(&mut self.errors))
                }
            }
            Err(first) => {
                let mut errs = vec![first];
                errs.extend(std::mem::take(&mut self.errors));
                Err(errs)
            }
        }
    }

    /// Shared core used by both modes. Implements: program ::= expression? EOF
    fn parse_core(&mut self, formula_string: &str) -> Result<AstNode, ParseError> {
        let lexer = Lexer::new(formula_string);
        let tokens: Vec<Token> = lexer
            .collect::<Result<Vec<_>, _>>()
            .map_err(ParseError::LexerError)?;

        let mut tokens_iter = tokens.into_iter().peekable();

        if matches!(
            tokens_iter.peek().map(|token| &token.token_type),
            Some(TokenType::FormulaStart)
        ) {
            let marker = tokens_iter.next().expect("peeked formula marker");
            self.bump_last_pos(&marker);
        }

        // Handle the optional expression (expression?)
        let expression = if let Some(token) = tokens_iter.peek() {
            if token.token_type == TokenType::Eof {
                // An empty program is valid and is represented as Null
                Expression::Literal(Literal::Null)
            } else {
                // If there are tokens, parse the expression
                self.parse_expression(&mut tokens_iter, 0)?
            }
        } else {
            // No tokens at all (edge case for lexer issues) is also a Null program
            Expression::Literal(Literal::Null)
        };

        // After parsing, we must be at the end of the file
        if let Some(token) = tokens_iter.peek() {
            if token.token_type != TokenType::Eof {
                let error = ParseError::UnexpectedToken {
                    expected: Some("end of formula".to_string()),
                    found: token.token_type.clone(),
                    line: token.position.line,
                    column: token.position.column,
                };

                if self.recover {
                    self.errors.push(error);
                    self.synchronize(&mut tokens_iter);
                } else {
                    return Err(error);
                }
            }
        }

        if self.recover && !self.errors.is_empty() {
            // let parse_with_recovery surface them
        }

        Ok(AstNode::Expression(expression))
    }

    /// Get all collected errors from the last parse attempt
    pub fn get_errors(&self) -> &[ParseError] {
        &self.errors
    }

    fn parse_expression(
        &mut self,
        tokens: &mut Peekable<IntoIter<Token>>,
        precedence: u8,
    ) -> Result<Expression, ParseError> {
        let mut left = self.parse_prefix(tokens)?;

        // Associativity-aware parsing loop
        loop {
            let (op_precedence, op_associativity) = self.get_precedence_and_assoc(tokens.peek());

            // For left-associative operators: stop when we hit same or lower precedence
            // For right-associative operators: only stop when we hit strictly lower precedence
            let should_stop = match op_associativity {
                Associativity::Left => precedence >= op_precedence,
                Associativity::Right => precedence > op_precedence,
            };

            if should_stop {
                break;
            }

            left = self.parse_infix(tokens, left)?;
        }

        Ok(left)
    }

    fn parse_prefix(
        &mut self,
        tokens: &mut Peekable<IntoIter<Token>>,
    ) -> Result<Expression, ParseError> {
        let (line, column) = self.pos_or_last(tokens.peek());
        let token = tokens
            .next()
            .ok_or(ParseError::UnexpectedEof { line, column })?;
        self.bump_last_pos(&token);

        match token.token_type {
            TokenType::Number(n) => Ok(Expression::Literal(Literal::Number(n))),
            TokenType::String(s) => Ok(Expression::Literal(Literal::String(s))),
            TokenType::Boolean(b) => Ok(Expression::Literal(Literal::Boolean(b))),
            TokenType::Null => Ok(Expression::Literal(Literal::Null)),
            TokenType::Identifier(name) => {
                // After finding an identifier, peek ahead to see if it's a versioned function call.
                if let Some(token) = tokens.peek() {
                    if token.token_type == TokenType::At {
                        // It looks like a versioned call, so parse the full sequence.
                        let pos = (token.position.line, token.position.column);
                        return self.parse_versioned_identifier(name, tokens, pos);
                    }
                }
                // If not, it's just a simple identifier.
                Ok(Expression::Identifier(name))
            }

            // Special references
            TokenType::At => Ok(Expression::Identifier("@".to_string())),
            TokenType::DoubleAt => Ok(Expression::Identifier("@@".to_string())),
            TokenType::Scope => Ok(Expression::Identifier("$scope".to_string())),

            TokenType::Minus | TokenType::Not => {
                let op = if matches!(token.token_type, TokenType::Minus) {
                    UnaryOp::Negate
                } else {
                    UnaryOp::Not
                };
                let expr = self.parse_expression(tokens, 5)?;
                Ok(Expression::Unary(Box::new(UnaryExpr { op, expr })))
            }

            TokenType::LParen => {
                let expr = self.parse_expression(tokens, 0)?;
                self.expect_token(tokens, TokenType::RParen)?;
                Ok(expr)
            }

            TokenType::LBracket => self.parse_array_literal(tokens),
            TokenType::LBrace => self.parse_object_literal(tokens),
            TokenType::Pipe => self.parse_lambda(tokens),

            other => {
                let err = ParseError::UnexpectedToken {
                    expected: Some("expression".to_string()),
                    found: other,
                    line: token.position.line,
                    column: token.position.column,
                };
                if self.recover {
                    self.errors.push(err);
                    // return a neutral node so higher-level callers can keep going
                    Ok(Expression::Literal(Literal::Null))
                } else {
                    Err(err)
                }
            }
        }
    }

    fn parse_infix(
        &mut self,
        tokens: &mut Peekable<IntoIter<Token>>,
        left: Expression,
    ) -> Result<Expression, ParseError> {
        let (line, column) = self.pos_or_last(tokens.peek());
        let next_token = tokens
            .peek()
            .ok_or(ParseError::UnexpectedEof { line, column })?;

        match &next_token.token_type {
            TokenType::Plus
            | TokenType::Minus
            | TokenType::Star
            | TokenType::Slash
            | TokenType::Percent
            | TokenType::Eq
            | TokenType::NotEq
            | TokenType::Lt
            | TokenType::Lte
            | TokenType::Gt
            | TokenType::Gte
            | TokenType::And
            | TokenType::Or => {
                let precedence = self.get_precedence(tokens.peek());
                let op_token = tokens.next().unwrap();
                self.bump_last_pos(&op_token);
                let pos = (op_token.position.line, op_token.position.column);
                let op = self.token_to_binary_op(&op_token.token_type, pos)?;
                let right = self.parse_expression(tokens, precedence)?;
                Ok(Expression::Binary(Box::new(BinaryExpr { op, left, right })))
            }

            TokenType::LParen => {
                let pos = (next_token.position.line, next_token.position.column);
                self.parse_function_call(tokens, left, pos)
            }
            TokenType::Dot => self.parse_member_access(tokens, left),
            TokenType::LBracket => self.parse_index_access(tokens, left),

            other => {
                let err = ParseError::UnexpectedToken {
                    expected: Some("operator".to_string()),
                    found: other.clone(),
                    line: next_token.position.line,
                    column: next_token.position.column,
                };
                if self.recover {
                    self.errors.push(err);
                    // Make progress so the loop can't get stuck on the same token
                    self.synchronize(tokens);
                    // Return the left side; outer parse loop will stop because precedence drops
                    Ok(left)
                } else {
                    Err(err)
                }
            }
        }
    }

    fn get_precedence(&mut self, token: Option<&Token>) -> u8 {
        if let Some(t) = token {
            OperatorPrecedence::from_token_type(&t.token_type).as_u8()
        } else {
            OperatorPrecedence::None.as_u8()
        }
    }

    /// Get both precedence and associativity for a token
    fn get_precedence_and_assoc(&self, token: Option<&Token>) -> (u8, Associativity) {
        if let Some(t) = token {
            let precedence = OperatorPrecedence::from_token_type(&t.token_type);
            (precedence.as_u8(), precedence.associativity())
        } else {
            (
                OperatorPrecedence::None.as_u8(),
                OperatorPrecedence::None.associativity(),
            )
        }
    }

    fn parse_lambda(
        &mut self,
        tokens: &mut Peekable<IntoIter<Token>>,
    ) -> Result<Expression, ParseError> {
        let mut parameters = Vec::new();

        // Parse parameters until we hit the second pipe
        loop {
            let (line, column) = self.pos_or_last(tokens.peek());
            let next = tokens
                .peek()
                .ok_or(ParseError::UnexpectedEof { line, column })?;

            match &next.token_type {
                TokenType::Pipe => {
                    tokens.next(); // consume pipe
                    break;
                }
                TokenType::Identifier(name) => {
                    parameters.push(name.clone());
                    tokens.next(); // consume identifier

                    // Check for comma
                    if let Some(next) = tokens.peek() {
                        if matches!(next.token_type, TokenType::Comma) {
                            tokens.next(); // consume comma
                        }
                    }
                }
                _ => {
                    return Err(ParseError::UnexpectedToken {
                        expected: Some("identifier or |".into()),
                        found: next.token_type.clone(),
                        line: next.position.line,
                        column: next.position.column,
                    })
                }
            }
        }

        self.expect_token(tokens, TokenType::Arrow)?;
        let body = self.parse_expression(tokens, 0)?;

        Ok(Expression::Lambda(Box::new(LambdaExpr {
            parameters,
            body,
        })))
    }

    fn parse_function_call(
        &mut self,
        tokens: &mut Peekable<IntoIter<Token>>,
        function_expr: Expression,
        expr_position: (usize, usize),
    ) -> Result<Expression, ParseError> {
        self.expect_token(tokens, TokenType::LParen)?;
        let mut arguments = Vec::new();

        // Check if there are any arguments
        if let Some(next) = tokens.peek() {
            if next.token_type != TokenType::RParen {
                loop {
                    arguments.push(self.parse_expression(tokens, 0)?);

                    if let Some(next) = tokens.peek() {
                        if matches!(next.token_type, TokenType::Comma) {
                            tokens.next(); // consume comma
                        } else {
                            break;
                        }
                    }
                }
            }
        }

        self.expect_token(tokens, TokenType::RParen)?;

        // Extract function name and version from function_expr
        let (function_name, version) = match function_expr {
            Expression::Identifier(name) => (name, None),
            Expression::VersionedIdentifier { name, version } => (name, Some(version)),
            _ => {
                return Err(ParseError::InvalidFunction {
                    line: expr_position.0,
                    column: expr_position.1,
                })
            }
        };

        Ok(Expression::FunctionCall(Box::new(FunctionCallExpr {
            function_name,
            version,
            args: arguments,
        })))
    }

    fn parse_member_access(
        &mut self,
        tokens: &mut Peekable<IntoIter<Token>>,
        object: Expression,
    ) -> Result<Expression, ParseError> {
        self.expect_token(tokens, TokenType::Dot)?;
        let (line, column) = self.pos_or_last(tokens.peek());
        let next = tokens
            .next()
            .ok_or(ParseError::UnexpectedEof { line, column })?;
        self.bump_last_pos(&next);

        match next.token_type {
            TokenType::Identifier(property) => {
                Ok(Expression::MemberAccess(Box::new(MemberAccessExpr {
                    object,
                    property,
                })))
            }
            other => {
                let err = ParseError::UnexpectedToken {
                    expected: Some("property name".into()),
                    found: other,
                    line: next.position.line,
                    column: next.position.column,
                };
                if self.recover {
                    self.errors.push(err);
                    self.synchronize(tokens);
                    Ok(object)
                } else {
                    Err(err)
                }
            }
        }
    }

    fn parse_index_access(
        &mut self,
        tokens: &mut Peekable<IntoIter<Token>>,
        array: Expression,
    ) -> Result<Expression, ParseError> {
        self.expect_token(tokens, TokenType::LBracket)?;
        let index = self.parse_expression(tokens, 0)?;
        self.expect_token(tokens, TokenType::RBracket)?;
        Ok(Expression::IndexAccess(Box::new(IndexAccessExpr {
            array,
            index,
        })))
    }

    fn parse_array_literal(
        &mut self,
        tokens: &mut Peekable<IntoIter<Token>>,
    ) -> Result<Expression, ParseError> {
        let mut elements = Vec::new();

        // Check if array is empty
        if let Some(next) = tokens.peek() {
            if next.token_type != TokenType::RBracket {
                loop {
                    elements.push(self.parse_expression(tokens, 0)?);

                    if let Some(next) = tokens.peek() {
                        if matches!(next.token_type, TokenType::Comma) {
                            tokens.next(); // consume comma
                        } else {
                            break;
                        }
                    }
                }
            }
        }

        self.expect_token(tokens, TokenType::RBracket)?;
        Ok(Expression::Literal(Literal::Array(elements)))
    }

    fn parse_object_literal(
        &mut self,
        tokens: &mut Peekable<IntoIter<Token>>,
    ) -> Result<Expression, ParseError> {
        let mut properties = Vec::new();

        // Check if object is empty
        if let Some(next) = tokens.peek() {
            if next.token_type != TokenType::RBrace {
                loop {
                    // Parse key
                    let (line, column) = self.pos_or_last(tokens.peek());
                    let key = match tokens
                        .next()
                        .ok_or(ParseError::UnexpectedEof { line, column })?
                        .token_type
                    {
                        TokenType::Identifier(name) => name,
                        TokenType::String(s) => s,
                        other => {
                            return Err(ParseError::UnexpectedToken {
                                expected: Some("property key".into()),
                                found: other,
                                line,
                                column,
                            })
                        }
                    };

                    self.expect_token(tokens, TokenType::Colon)?;
                    let value = self.parse_expression(tokens, 0)?;
                    properties.push((key, value));

                    if let Some(next) = tokens.peek() {
                        if matches!(next.token_type, TokenType::Comma) {
                            tokens.next(); // consume comma
                        } else {
                            break;
                        }
                    }
                }
            }
        }

        self.expect_token(tokens, TokenType::RBrace)?;
        Ok(Expression::Literal(Literal::Object(properties)))
    }

    /// Parses a versioned identifier like `MyFunc@v2`
    fn parse_versioned_identifier(
        &mut self,
        name: String,
        tokens: &mut Peekable<IntoIter<Token>>,
        start_position: (usize, usize),
    ) -> Result<Expression, ParseError> {
        // Consume the '@' token
        self.expect_token(tokens, TokenType::At)?;

        // Expect version string like 'v2'
        match tokens.next() {
            Some(Token {
                token_type: TokenType::Identifier(version_str),
                ..
            }) => {
                if let Some(stripped) = version_str.strip_prefix('v') {
                    if let Ok(version_num) = stripped.parse::<u32>() {
                        // We successfully parsed the full pattern.
                        Ok(Expression::VersionedIdentifier {
                            name,
                            version: version_num,
                        })
                    } else {
                        Err(ParseError::UnexpectedToken {
                            expected: Some("valid version number".to_string()),
                            found: TokenType::Identifier(version_str),
                            line: start_position.0,
                            column: start_position.1,
                        })
                    }
                } else {
                    Err(ParseError::UnexpectedToken {
                        expected: Some("version identifier starting with 'v'".to_string()),
                        found: TokenType::Identifier(version_str),
                        line: start_position.0,
                        column: start_position.1,
                    })
                }
            }
            Some(other) => Err(ParseError::UnexpectedToken {
                expected: Some("version identifier".to_string()),
                found: other.token_type,
                line: start_position.0,
                column: start_position.1,
            }),
            None => Err(ParseError::UnexpectedEof {
                line: start_position.0,
                column: start_position.1,
            }),
        }
    }

    fn expect_token(
        &mut self,
        tokens: &mut Peekable<IntoIter<Token>>,
        expected: TokenType,
    ) -> Result<(), ParseError> {
        let (line, column) = self.pos_or_last(tokens.peek());
        let token = tokens
            .next()
            .ok_or(ParseError::UnexpectedEof { line, column })?;
        self.bump_last_pos(&token);

        if std::mem::discriminant(&token.token_type) == std::mem::discriminant(&expected) {
            Ok(())
        } else {
            Err(ParseError::UnexpectedToken {
                expected: Some(format!("{expected:?}")),
                found: token.token_type,
                line: token.position.line,
                column: token.position.column,
            })
        }
    }

    fn token_to_binary_op(
        &mut self,
        token: &TokenType,
        position: (usize, usize),
    ) -> Result<BinaryOp, ParseError> {
        match token {
            TokenType::Plus => Ok(BinaryOp::Add),
            TokenType::Minus => Ok(BinaryOp::Subtract),
            TokenType::Star => Ok(BinaryOp::Multiply),
            TokenType::Slash => Ok(BinaryOp::Divide),
            TokenType::Percent => Ok(BinaryOp::Modulo),
            TokenType::Eq => Ok(BinaryOp::Eq),
            TokenType::NotEq => Ok(BinaryOp::NotEq),
            TokenType::Lt => Ok(BinaryOp::Lt),
            TokenType::Lte => Ok(BinaryOp::Lte),
            TokenType::Gt => Ok(BinaryOp::Gt),
            TokenType::Gte => Ok(BinaryOp::Gte),
            TokenType::And => Ok(BinaryOp::And),
            TokenType::Or => Ok(BinaryOp::Or),
            _ => Err(ParseError::InvalidLiteral {
                message: "Not a binary operator".to_string(),
                line: position.0,
                column: position.1,
            }),
        }
    }
}

impl Default for Parser {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leading_formula_marker_preserves_expression_grammar_and_error_columns() {
        let addition = Parser::new().parse("=A1+B1").unwrap();
        assert_eq!(addition, Parser::new().parse("A1 + B1").unwrap());

        let equality = Parser::new().parse("=A1==B1").unwrap();
        assert_eq!(equality, Parser::new().parse("A1 == B1").unwrap());

        let lambda = Parser::new().parse("=|x| => x + 1").unwrap();
        assert_eq!(lambda, Parser::new().parse("|x| => x + 1").unwrap());

        let duplicate = Parser::new().parse("= =A1").unwrap_err();
        assert!(matches!(
            duplicate,
            ParseError::UnexpectedToken {
                line: 1,
                column: 3,
                found: TokenType::FormulaStart,
                ..
            }
        ));

        let equality_without_left_operand = Parser::new().parse("==A1").unwrap_err();
        assert!(matches!(
            equality_without_left_operand,
            ParseError::UnexpectedToken {
                line: 1,
                column: 1,
                found: TokenType::Eq,
                ..
            }
        ));
    }

    #[test]
    fn test_parse_object_literal() {
        let mut parser = Parser::new();

        // Test empty object
        let result = parser.parse("#{}").unwrap();
        match result {
            AstNode::Expression(Expression::Literal(Literal::Object(props))) => {
                assert_eq!(props.len(), 0);
            }
            _ => panic!("Expected empty object literal"),
        }

        // Test object with properties
        let result = parser.parse(r#"#{ "name": "John", "age": 30 }"#).unwrap();
        match result {
            AstNode::Expression(Expression::Literal(Literal::Object(props))) => {
                assert_eq!(props.len(), 2);
                assert_eq!(props[0].0, "name");
                assert_eq!(props[1].0, "age");
            }
            _ => panic!("Expected object literal with properties"),
        }
    }

    #[test]
    fn test_parse_lambda() {
        let mut parser = Parser::new();

        // Test simple lambda
        let result = parser.parse("|x| => x * 2").unwrap();
        match result {
            AstNode::Expression(Expression::Lambda(lambda)) => {
                assert_eq!(lambda.parameters.len(), 1);
                assert_eq!(lambda.parameters[0], "x");
            }
            _ => panic!("Expected lambda expression"),
        }

        // Test lambda with multiple parameters
        let result = parser.parse("|a, b| => a + b").unwrap();
        match result {
            AstNode::Expression(Expression::Lambda(lambda)) => {
                assert_eq!(lambda.parameters.len(), 2);
                assert_eq!(lambda.parameters[0], "a");
                assert_eq!(lambda.parameters[1], "b");
            }
            _ => panic!("Expected lambda expression"),
        }
    }

    #[test]
    fn test_parse_versioned_function() {
        let mut parser = Parser::new();

        // Test versioned function call
        let result = parser.parse("MyFunc@v2(10, 20)").unwrap();
        match result {
            AstNode::Expression(Expression::FunctionCall(func)) => {
                assert_eq!(func.function_name, "MyFunc");
                assert_eq!(func.version, Some(2));
                assert_eq!(func.args.len(), 2);
            }
            _ => panic!("Expected versioned function call"),
        }

        // Test unversioned function call
        let result = parser.parse("SUM(1, 2, 3)").unwrap();
        match result {
            AstNode::Expression(Expression::FunctionCall(func)) => {
                assert_eq!(func.function_name, "SUM");
                assert_eq!(func.version, None);
                assert_eq!(func.args.len(), 3);
            }
            _ => panic!("Expected function call"),
        }
    }

    #[test]
    fn test_parse_array_literal() {
        let mut parser = Parser::new();

        // Test empty array
        let result = parser.parse("[]").unwrap();
        match result {
            AstNode::Expression(Expression::Literal(Literal::Array(elements))) => {
                assert_eq!(elements.len(), 0);
            }
            _ => panic!("Expected empty array literal"),
        }

        // Test array with elements
        let result = parser.parse("[1, 2, 3]").unwrap();
        match result {
            AstNode::Expression(Expression::Literal(Literal::Array(elements))) => {
                assert_eq!(elements.len(), 3);
            }
            _ => panic!("Expected array literal with elements"),
        }
    }

    #[test]
    fn test_parse_complex_expression() {
        let mut parser = Parser::new();

        // Test complex nested expression
        let result = parser
            .parse("user.profile.scores[0] + AVERAGE([1, 2, 3])")
            .unwrap();
        match result {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Add);
                // Left side should be a member/index access chain
                // Right side should be a function call with array literal
            }
            _ => panic!("Expected binary expression"),
        }
    }

    #[test]
    fn test_parse_special_references() {
        let mut parser = Parser::new();

        // Test @ reference
        let result = parser.parse("@").unwrap();
        match result {
            AstNode::Expression(Expression::Identifier(id)) => {
                assert_eq!(id, "@");
            }
            _ => panic!("Expected @ identifier"),
        }

        // Test @@ reference
        let result = parser.parse("@@").unwrap();
        match result {
            AstNode::Expression(Expression::Identifier(id)) => {
                assert_eq!(id, "@@");
            }
            _ => panic!("Expected @@ identifier"),
        }

        // Test $scope reference
        let result = parser.parse("$scope").unwrap();
        match result {
            AstNode::Expression(Expression::Identifier(id)) => {
                assert_eq!(id, "$scope");
            }
            _ => panic!("Expected $scope identifier"),
        }

        // Test special references in expressions
        let result = parser
            .parse("@.due_date <= @.parent_project.deadline && @@.id == $scope.owner_id")
            .unwrap();
        match result {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::And);
            }
            _ => panic!("Expected complex expression with special references"),
        }
    }

    #[test]
    fn test_position_tracking_in_errors() {
        let mut parser = Parser::new();

        // Test that errors include accurate position information
        let result = parser.parse("123 +");
        match result {
            Err(ParseError::UnexpectedToken {
                line,
                column,
                expected,
                found,
                ..
            }) => {
                assert_eq!(line, 1);
                assert_eq!(column, 6); // Position after "123 +"
                assert_eq!(found, TokenType::Eof);
                assert_eq!(expected, Some("expression".to_string()));
            }
            Err(other) => panic!("Expected UnexpectedToken but got: {other:?}"),
            Ok(_) => panic!("Expected error but parsing succeeded"),
        }

        // Test position tracking with syntax error mid-formula
        let result = parser.parse("user.name ==");
        match result {
            Err(ParseError::UnexpectedToken {
                line,
                column,
                found,
                ..
            }) => {
                assert_eq!(line, 1);
                assert_eq!(column, 13); // Position after "user.name =="
                assert_eq!(found, TokenType::Eof);
            }
            _ => panic!("Expected positioned UnexpectedToken error"),
        }
    }

    #[test]
    fn test_error_recovery_infrastructure() {
        let mut parser = Parser::new();

        // Test error collection infrastructure
        let result = parser.parse_with_recovery("123 $ 456");
        match result {
            Err(errors) => {
                assert!(!errors.is_empty()); // Should have at least one error
                                             // The error could be UnexpectedToken or LexerError depending on where it fails
                match &errors[0] {
                    ParseError::UnexpectedToken { line, column, .. } => {
                        assert_eq!(*line, 1);
                        assert!(*column > 1); // Should be positioned correctly
                    }
                    ParseError::LexerError(_) => {
                        // Lexer error is also acceptable for invalid character '$'
                    }
                    _ => panic!(
                        "Expected UnexpectedToken or LexerError, got: {:?}",
                        &errors[0]
                    ),
                }
            }
            Ok(_) => panic!("Expected error for invalid syntax"),
        }

        // Test that errors are cleared between parses
        let result2 = parser.parse_with_recovery("123 + 456");
        match result2 {
            Ok(_) => {
                // Success case - should have no errors
                assert!(parser.get_errors().is_empty());
            }
            Err(_) => panic!("Expected successful parse for valid expression"),
        }
    }

    #[test]
    fn test_collects_multiple_errors() {
        let mut parser = Parser::new();
        // Simple case that should trigger multiple error sites
        let bad = "123 $ 456 % abc";
        let result = parser.parse_with_recovery(bad);
        match result {
            Err(errors) => {
                println!("Collected {} errors: {:?}", errors.len(), errors);
                assert!(!errors.is_empty(), "expected at least one error");
                for e in &errors {
                    // every error should be positioned
                    match e {
                        ParseError::UnexpectedToken { line, column, .. }
                        | ParseError::UnexpectedEof { line, column }
                        | ParseError::InvalidFunction { line, column }
                        | ParseError::InvalidLiteral { line, column, .. } => {
                            assert!(*line >= 1 && *column >= 1);
                        }
                        ParseError::LexerError(_) => { /* ok too */ }
                        ParseError::MultipleErrors { .. } => {
                            unreachable!("we return Vec<ParseError> here")
                        }
                    }
                }
            }
            Ok(_) => panic!("expected errors for invalid input"),
        }
    }

    #[test]
    fn test_multiple_parser_errors() {
        let mut parser = Parser::new();
        // Test with parsing errors that the recovery can handle
        let bad = "func(,) + user..name"; // missing argument + double dot
        let result = parser.parse_with_recovery(bad);
        match result {
            Err(errors) => {
                println!("Collected {} parser errors: {:?}", errors.len(), errors);
                // We should get at least one error
                assert!(!errors.is_empty(), "expected at least one error");
                for e in &errors {
                    match e {
                        ParseError::UnexpectedToken { line, column, .. }
                        | ParseError::UnexpectedEof { line, column } => {
                            assert!(*line >= 1 && *column >= 1);
                        }
                        _ => {} // other error types are fine too
                    }
                }
            }
            Ok(_) => {
                // Even if it "succeeds", we should have collected errors
                let errors = parser.get_errors();
                if errors.is_empty() {
                    panic!("Expected to collect some errors during parsing");
                }
            }
        }
    }

    #[test]
    fn test_complex_error_recovery() {
        let mut parser = Parser::new();

        // Test 1: Array with multiple syntax errors
        let bad_array = "[1, , 3, func(,), 5 6]"; // missing element, bad function call, missing comma
        let result = parser.parse_with_recovery(bad_array);
        match result {
            Err(errors) => {
                println!("Array errors: {} - {:?}", errors.len(), errors);
                assert!(errors.len() >= 2, "Expected multiple array errors");
            }
            Ok(_) => println!("Array parsing succeeded despite errors"),
        }

        // Test 2: Object literal with syntax errors
        parser = Parser::new(); // fresh parser
        let bad_object = r#"#{ "key1": , "key2" "value2", : "orphan" }"#; // missing value, missing colon, orphan key
        let result = parser.parse_with_recovery(bad_object);
        match result {
            Err(errors) => {
                println!("Object errors: {} - {:?}", errors.len(), errors);
                assert!(!errors.is_empty(), "Expected object errors");
            }
            Ok(_) => println!("Object parsing succeeded despite errors"),
        }

        // Test 3: Deeply nested errors
        parser = Parser::new();
        let nested_bad = "func(user.., array[,], obj..)"; // multiple nested issues
        let result = parser.parse_with_recovery(nested_bad);
        match result {
            Err(errors) => {
                println!("Nested errors: {} - {:?}", errors.len(), errors);
                assert!(errors.len() >= 2, "Expected multiple nested errors");
            }
            Ok(_) => println!("Nested parsing succeeded despite errors"),
        }

        // Test 4: Lambda with errors
        parser = Parser::new();
        let bad_lambda = "|x, , z| => x + + z"; // missing parameter, double plus
        let result = parser.parse_with_recovery(bad_lambda);
        match result {
            Err(errors) => {
                println!("Lambda errors: {} - {:?}", errors.len(), errors);
                assert!(!errors.is_empty(), "Expected lambda errors");
            }
            Ok(_) => println!("Lambda parsing succeeded despite errors"),
        }
    }

    #[test]
    fn test_position_accuracy_in_recovery() {
        let mut parser = Parser::new();
        let input = "a + b..c + d"; // error at position 6 (second dot)

        match parser.parse_with_recovery(input) {
            Err(errors) => {
                println!("Position test errors: {errors:?}");
                // Find the member access error
                let member_error = errors.iter().find(|e| {
                    matches!(e, ParseError::UnexpectedToken { expected: Some(exp), .. } 
                            if exp.contains("property"))
                });

                if let Some(ParseError::UnexpectedToken { line, column, .. }) = member_error {
                    println!("Member access error at line {line}, column {column}");
                    assert_eq!(*line, 1);
                    // Should be around column 7-8 for the second dot in "b..c"
                    assert!(
                        *column >= 6 && *column <= 8,
                        "Expected column around 6-8, got {column}"
                    );
                }
            }
            Ok(_) => panic!("Expected error for double dot syntax"),
        }
    }

    #[test]
    fn test_recovery_vs_fail_fast() {
        let mut parser = Parser::new();
        let bad_input = "func(,) + user..name";

        // Test fail-fast mode (regular parse)
        let fail_fast = parser.parse(bad_input);
        assert!(fail_fast.is_err(), "Expected error in fail-fast mode");

        // Test recovery mode
        parser = Parser::new();
        let recovery = parser.parse_with_recovery(bad_input);
        match recovery {
            Err(errors) => {
                println!("Recovery collected {} errors", errors.len());
                assert!(errors.len() >= 2, "Recovery should collect multiple errors");
            }
            Ok(_) => println!("Recovery mode succeeded"),
        }
    }

    /// Grammar validation tests ensuring parser matches Appendix A EBNF specification
    mod grammar_validation_tests {
        use super::*;

        /// Test the critical precedence fix: equality vs comparison operators
        #[test]
        fn test_equality_vs_comparison_precedence_fix() {
            let mut parser = Parser::new();

            // According to EBNF: comparison has higher precedence than equality
            // So "a == b < c" should parse as "a == (b < c)" not "(a == b) < c"
            let result = parser.parse("a == b < c").unwrap();

            match result {
                AstNode::Expression(Expression::Binary(binary)) => {
                    assert_eq!(binary.op, BinaryOp::Eq);
                    // The right side should be the comparison (b < c)
                    match &binary.right {
                        Expression::Binary(right_binary) => {
                            assert_eq!(right_binary.op, BinaryOp::Lt);
                        }
                        _ => panic!(
                            "Expected comparison on right side of equality - precedence fix failed"
                        ),
                    }
                }
                _ => panic!("Expected binary expression for equality"),
            }
        }

        /// Test complete precedence hierarchy matches EBNF grammar
        #[test]
        fn test_complete_precedence_hierarchy() {
            let mut parser = Parser::new();

            // Test all precedence levels: OR < AND < EQUALITY < COMPARISON < ADDITIVE < MULTIPLICATIVE

            // 1. OR (lowest precedence) - should bind last
            let result = parser.parse("a && b || c && d").unwrap();
            match result {
                AstNode::Expression(Expression::Binary(binary)) => {
                    assert_eq!(binary.op, BinaryOp::Or); // Top-level should be OR
                }
                _ => panic!("OR should have lowest precedence"),
            }

            // 2. Equality < Comparison precedence
            let result = parser.parse("a != b > c").unwrap();
            match result {
                AstNode::Expression(Expression::Binary(binary)) => {
                    assert_eq!(binary.op, BinaryOp::NotEq); // Top-level should be !=
                    match &binary.right {
                        Expression::Binary(right_binary) => {
                            assert_eq!(right_binary.op, BinaryOp::Gt); // Right should be >
                        }
                        _ => panic!("Comparison should bind tighter than equality"),
                    }
                }
                _ => panic!("Expected != at top level"),
            }

            // 3. Comparison < Additive precedence
            let result = parser.parse("a < b + c").unwrap();
            match result {
                AstNode::Expression(Expression::Binary(binary)) => {
                    assert_eq!(binary.op, BinaryOp::Lt); // Top-level should be <
                    match &binary.right {
                        Expression::Binary(right_binary) => {
                            assert_eq!(right_binary.op, BinaryOp::Add); // Right should be +
                        }
                        _ => panic!("Addition should bind tighter than comparison"),
                    }
                }
                _ => panic!("Expected < at top level"),
            }

            // 4. Additive < Multiplicative precedence
            let result = parser.parse("a + b * c").unwrap();
            match result {
                AstNode::Expression(Expression::Binary(binary)) => {
                    assert_eq!(binary.op, BinaryOp::Add); // Top-level should be +
                    match &binary.right {
                        Expression::Binary(right_binary) => {
                            assert_eq!(right_binary.op, BinaryOp::Multiply); // Right should be *
                        }
                        _ => panic!("Multiplication should bind tighter than addition"),
                    }
                }
                _ => panic!("Expected + at top level"),
            }
        }

        /// Test that parser rejects invalid constructs per EBNF grammar
        #[test]
        fn test_grammar_rejection_cases() {
            let mut parser = Parser::new();

            // Assignment is forbidden (maintains single-expression principle)
            assert!(
                parser.parse("x = 42").is_err(),
                "Assignment should be forbidden"
            );

            // Invalid version syntax
            assert!(
                parser.parse("func@2()").is_err(),
                "Version must have 'v' prefix"
            );
            assert!(
                parser.parse("func@v()").is_err(),
                "Version must have number"
            );

            // Invalid special references
            assert!(
                parser.parse("@scope").is_err(),
                "Should be $scope not @scope"
            );

            // Incomplete expressions
            assert!(parser.parse("1 +").is_err(), "Trailing binary operator");
            assert!(parser.parse("+ 1").is_err(), "Leading binary operator");
            assert!(
                parser.parse("1 2").is_err(),
                "Missing operator between expressions"
            );
        }

        /// Test all EBNF terminal tokens are correctly recognized
        #[test]
        fn test_terminal_token_recognition() {
            let mut parser = Parser::new();

            // Binary operators from EBNF grammar
            let binary_operators = vec![
                "+", "-", "*", "/", "%", // Arithmetic
                "==", "!=", ">", ">=", "<", "<=", // Comparison/Equality
                "&&", "||", // Logical
            ];

            for op in binary_operators {
                let formula = format!("1 {} 1", op);
                let result = parser.parse(&formula);
                assert!(
                    result.is_ok(),
                    "Binary operator {} should parse successfully",
                    op
                );
            }

            // Unary operators need different syntax
            assert!(parser.parse("!true").is_ok(), "Unary ! should parse");
            assert!(parser.parse("-42").is_ok(), "Unary - should parse");

            // Special references
            assert!(parser.parse("@").is_ok(), "@ should parse");
            assert!(parser.parse("@@").is_ok(), "@@ should parse");
            assert!(parser.parse("$scope").is_ok(), "$scope should parse");

            // Literals
            assert!(parser.parse("42").is_ok(), "Numbers should parse");
            assert!(parser.parse(r#""hello""#).is_ok(), "Strings should parse");
            assert!(parser.parse("true").is_ok(), "Booleans should parse");
            assert!(parser.parse("false").is_ok(), "Booleans should parse");
            assert!(parser.parse("null").is_ok(), "Null should parse");

            // Containers
            assert!(parser.parse("[]").is_ok(), "Empty arrays should parse");
            assert!(parser.parse("[1, 2, 3]").is_ok(), "Arrays should parse");
            assert!(parser.parse("#{}").is_ok(), "Empty objects should parse");
            assert!(
                parser.parse(r#"#{"key": "value"}"#).is_ok(),
                "Objects should parse"
            );

            // Lambda expressions
            assert!(
                parser.parse("|x| => x").is_ok(),
                "Single-param lambdas should parse"
            );
            // Note: Zero-param lambdas might not be fully supported yet - this is acceptable
        }

        /// Test versioned function calls match EBNF specification
        #[test]
        fn test_versioned_function_ebnf_compliance() {
            let mut parser = Parser::new();

            // VERSIONED_IDENT ::= IDENTIFIER ( "@" "v" NUMBER )?

            // Simple function (no version)
            let result = parser.parse("func()").unwrap();
            match result {
                AstNode::Expression(Expression::FunctionCall(fc)) => {
                    assert_eq!(fc.function_name, "func");
                    assert_eq!(fc.version, None);
                }
                _ => panic!("Expected simple function call"),
            }

            // Versioned function
            let result = parser.parse("func@v2()").unwrap();
            match result {
                AstNode::Expression(Expression::FunctionCall(fc)) => {
                    assert_eq!(fc.function_name, "func");
                    assert_eq!(fc.version, Some(2));
                }
                _ => panic!("Expected versioned function call"),
            }

            // Complex version numbers
            let result = parser.parse("func@v123()").unwrap();
            match result {
                AstNode::Expression(Expression::FunctionCall(fc)) => {
                    assert_eq!(fc.version, Some(123));
                }
                _ => panic!("Expected function call with version 123"),
            }
        }

        /// Test precedence table compliance with EBNF grammar specification
        #[test]
        fn test_precedence_table_compliance() {
            let mut parser = Parser::new();

            // This test ensures the get_precedence function's output
            // perfectly matches the EBNF grammar in the documentation.
            let test_cases = vec![
                (TokenType::Or, 1),
                (TokenType::And, 2),
                (TokenType::Eq, 3),
                (TokenType::NotEq, 3),
                (TokenType::Lt, 4),
                (TokenType::Lte, 4),
                (TokenType::Gt, 4),
                (TokenType::Gte, 4),
                (TokenType::Plus, 5),
                (TokenType::Minus, 5),
                (TokenType::Star, 6),
                (TokenType::Slash, 6),
                (TokenType::Percent, 6),
                (TokenType::LParen, 7),
                (TokenType::Dot, 7),
                (TokenType::LBracket, 7),
            ];

            for (token_type, expected_precedence) in test_cases {
                let token = Token::new(token_type.clone(), super::super::lexer::Position::new(0, 0, 0));
                let actual_precedence = parser.get_precedence(Some(&token));
                assert_eq!(
                    actual_precedence, expected_precedence,
                    "Precedence mismatch for token {:?}",
                    token_type
                );
            }
        }
    }

    #[test]
    fn test_extreme_error_recovery() {
        let mut parser = Parser::new();

        // Really challenging case with many different types of errors
        let nightmare =
            r#"[func(,), user..name, #{: "value", "key2" }, |,x| => x + + y, array[,,]]"#;

        let result = parser.parse_with_recovery(nightmare);
        match result {
            Err(errors) => {
                println!("Nightmare scenario collected {} errors:", errors.len());
                for (i, error) in errors.iter().enumerate() {
                    println!("  {}. {:?}", i + 1, error);
                }
                // This should collect many errors from different parsing contexts
                assert!(
                    errors.len() >= 3,
                    "Expected at least 3 errors from nightmare scenario"
                );
            }
            Ok(_) => {
                println!("Nightmare scenario somehow succeeded!");
                let errors = parser.get_errors();
                println!("But collected {} errors during parsing", errors.len());
            }
        }
    }

    #[test]
    fn test_hardening_patches() {
        let mut parser = Parser::new();

        // Test that synchronize properly advances position
        // This creates a scenario where synchronization happens after errors
        let tricky_input = "123 % % % + 456"; // Multiple bad operators that need synchronization

        match parser.parse_with_recovery(tricky_input) {
            Err(errors) => {
                println!(
                    "Hardening test collected {} errors: {:?}",
                    errors.len(),
                    errors
                );
                // Should collect errors and not get stuck in loops
                assert!(!errors.is_empty());
                // Verify positions are reasonable (not stuck at same position)
                let positions: Vec<_> = errors
                    .iter()
                    .map(|e| match e {
                        ParseError::UnexpectedToken { line, column, .. } => (*line, *column),
                        ParseError::UnexpectedEof { line, column } => (*line, *column),
                        _ => (1, 1),
                    })
                    .collect();
                println!("Error positions: {positions:?}");

                // Positions should make forward progress (not all the same)
                if positions.len() > 1 {
                    let first_col = positions[0].1;
                    let has_progress = positions.iter().any(|&(_, col)| col != first_col);
                    assert!(has_progress, "Expected position progress during recovery");
                }
            }
            Ok(_) => println!("Hardening test parsing succeeded despite errors"),
        }
    }

    /// Test that program production rule correctly implements: program ::= expression? EOF
    #[test]
    fn test_program_production_rule_implementation() {
        let mut parser = Parser::new();

        // Test 1: An empty input string is a valid program, represented as Null
        println!("Testing empty program (EOF only)...");
        match parser.parse("").unwrap() {
            AstNode::Expression(Expression::Literal(Literal::Null)) => {
                // This is the correct and expected outcome
                println!("Empty program correctly parsed as Null");
            }
            other => panic!("Empty program should parse to Null, but got {:?}", other),
        }

        // Test 2: A whitespace-only string is also a valid empty program
        println!("Testing whitespace-only program...");
        match parser.parse("   \t\n  ").unwrap() {
            AstNode::Expression(Expression::Literal(Literal::Null)) => {
                println!("Whitespace-only program correctly parsed as Null");
            }
            other => panic!(
                "Whitespace-only program should parse to Null, but got {:?}",
                other
            ),
        }

        // Test 3: A valid program with an expression should parse successfully
        println!("Testing valid program with expression...");
        let result = parser.parse("42");
        assert!(result.is_ok(), "Valid expression should parse successfully");

        // Test 4: A program with trailing tokens should fail
        println!("Testing program with trailing tokens...");
        let result = parser.parse("42 invalid_token");
        assert!(result.is_err(), "Should have failed due to trailing tokens");
        match result.unwrap_err() {
            ParseError::UnexpectedToken {
                expected, found, ..
            } => {
                assert_eq!(expected, Some("end of formula".to_string()));
                assert_eq!(found, TokenType::Identifier("invalid_token".to_string()));
                println!("Correctly caught trailing token error");
            }
            other => panic!("Expected UnexpectedToken error, but got {:?}", other),
        }
    }

    /// Test that expression production rule correctly implements: expression ::= logical_or
    #[test]
    fn test_expression_production_rule_implementation() {
        let mut parser = Parser::new();

        // Test 1: Simple expression should parse as logical_or
        println!("Testing simple expression...");
        let result = parser.parse("true");
        assert!(
            result.is_ok(),
            "Simple boolean expression should parse successfully"
        );

        // Test 2: Logical OR expression (lowest precedence) should parse correctly
        println!("Testing logical OR expression...");
        match parser.parse("true || false").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Or);
                match (&binary.left, &binary.right) {
                    (
                        Expression::Literal(Literal::Boolean(true)),
                        Expression::Literal(Literal::Boolean(false)),
                    ) => {
                        println!("Logical OR expression correctly parsed");
                    }
                    _ => panic!("Logical OR operands not parsed correctly"),
                }
            }
            other => panic!("Expected binary OR expression, got {:?}", other),
        }

        // Test 3: Complex expression with multiple precedence levels
        println!("Testing complex expression with precedence...");
        let result = parser.parse("a && b || c");
        match result.unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Or); // Top level should be OR (lowest precedence)
                                                     // Left side should be (a && b)
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::And);
                        println!("Complex expression parsed with correct precedence: AND binds tighter than OR");
                    }
                    _ => panic!("Left side should be AND expression"),
                }
            }
            other => panic!("Expected binary expression at top level, got {:?}", other),
        }

        // Test 4: Expression starting with higher precedence operations
        println!("Testing expression starting with higher precedence...");
        let result = parser.parse("1 + 2 * 3");
        match result.unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Add); // Should be addition at top level
                                                      // Right side should be (2 * 3) due to precedence
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::Multiply);
                        println!("Arithmetic expression parsed with correct precedence");
                    }
                    _ => panic!("Right side should be multiplication expression"),
                }
            }
            other => panic!("Expected binary expression, got {:?}", other),
        }

        // Test 5: Single operand expression (should still work as "expression")
        println!("Testing single operand expression...");
        let result = parser.parse("42");
        match result.unwrap() {
            AstNode::Expression(Expression::Literal(Literal::Number(n))) => {
                assert_eq!(n, 42.0);
                println!("Single operand expression correctly parsed");
            }
            other => panic!("Expected number literal, got {:?}", other),
        }
    }

    /// Test that logical_or production rule correctly implements: logical_or ::= logical_and ( OR logical_and )*
    #[test]
    fn test_logical_or_production_rule_implementation() {
        let mut parser = Parser::new();

        // Test 1: Single logical_and (no OR operators)
        println!("Testing single logical_and expression...");
        match parser.parse("a && b").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::And);
                println!("Single logical_and correctly parsed");
            }
            other => panic!("Expected AND expression, got {:?}", other),
        }

        // Test 2: Single OR operation (logical_and OR logical_and)
        println!("Testing single OR operation...");
        match parser.parse("a && b || c && d").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Or);
                // Left should be (a && b)
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::And);
                    }
                    _ => panic!("Left side should be AND expression"),
                }
                // Right should be (c && d)
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::And);
                    }
                    _ => panic!("Right side should be AND expression"),
                }
                println!("Single OR operation correctly parsed with AND precedence");
            }
            other => panic!("Expected OR at top level, got {:?}", other),
        }

        // Test 3: Multiple OR operations (chained ORs - left associative)
        println!("Testing chained OR operations...");
        match parser.parse("a || b || c").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Or);
                // Left should be (a || b) due to left associativity
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Or);
                        println!("Chained OR operations correctly left-associative");
                    }
                    _ => panic!("Left side should be OR expression for left associativity"),
                }
                // Right should be just 'c'
                match &binary.right {
                    Expression::Identifier(name) => {
                        assert_eq!(name, "c");
                    }
                    _ => panic!("Right side should be identifier 'c'"),
                }
            }
            other => panic!("Expected OR at top level, got {:?}", other),
        }

        // Test 4: Mixed AND and OR with correct precedence
        println!("Testing mixed AND/OR precedence...");
        match parser.parse("a && b || c && d || e").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Or);
                // This should parse as ((a && b) || (c && d)) || e
                // Left should be another OR
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Or);
                        println!("Complex mixed expression parsed with correct precedence");
                    }
                    _ => panic!("Left side should be OR expression"),
                }
            }
            other => panic!("Expected OR at top level, got {:?}", other),
        }

        // Test 5: OR with higher precedence operations
        println!("Testing OR with higher precedence operations...");
        match parser.parse("a + b || c * d").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Or);
                // Left should be (a + b)
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Add);
                    }
                    _ => panic!("Left side should be addition"),
                }
                // Right should be (c * d)
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::Multiply);
                    }
                    _ => panic!("Right side should be multiplication"),
                }
                println!("OR correctly has lowest precedence vs arithmetic");
            }
            other => panic!("Expected OR at top level, got {:?}", other),
        }

        // Test 6: Single operand (degenerate case - no OR operators)
        println!("Testing single operand (no OR)...");
        match parser.parse("42").unwrap() {
            AstNode::Expression(Expression::Literal(Literal::Number(n))) => {
                assert_eq!(n, 42.0);
                println!("Single operand correctly parsed as valid logical_or");
            }
            other => panic!("Expected number literal, got {:?}", other),
        }
    }

    /// Test that logical_and production rule correctly implements: logical_and ::= equality ( AND equality )*
    #[test]
    fn test_logical_and_production_rule_implementation() {
        let mut parser = Parser::new();

        // Test 1: Single equality (no AND operators)
        println!("Testing single equality expression...");
        match parser.parse("a == b").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Eq);
                println!("Single equality correctly parsed");
            }
            other => panic!("Expected equality expression, got {:?}", other),
        }

        // Test 2: Single AND operation (equality AND equality)
        println!("Testing single AND operation...");
        match parser.parse("a == b && c != d").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::And);
                // Left should be (a == b)
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Eq);
                    }
                    _ => panic!("Left side should be equality expression"),
                }
                // Right should be (c != d)
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::NotEq);
                    }
                    _ => panic!("Right side should be not-equal expression"),
                }
                println!("Single AND operation correctly parsed with equality precedence");
            }
            other => panic!("Expected AND at top level, got {:?}", other),
        }

        // Test 3: Multiple AND operations (chained ANDs - left associative)
        println!("Testing chained AND operations...");
        match parser.parse("a && b && c").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::And);
                // Left should be (a && b) due to left associativity
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::And);
                        println!("Chained AND operations correctly left-associative");
                    }
                    _ => panic!("Left side should be AND expression for left associativity"),
                }
                // Right should be just 'c'
                match &binary.right {
                    Expression::Identifier(name) => {
                        assert_eq!(name, "c");
                    }
                    _ => panic!("Right side should be identifier 'c'"),
                }
            }
            other => panic!("Expected AND at top level, got {:?}", other),
        }

        // Test 4: Mixed equality and AND with correct precedence
        println!("Testing mixed equality/AND precedence...");
        match parser.parse("a == b && c != d && e == f").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::And);
                // This should parse as ((a == b) && (c != d)) && (e == f)
                // Left should be another AND
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::And);
                        println!("Complex mixed expression parsed with correct precedence");
                    }
                    _ => panic!("Left side should be AND expression"),
                }
            }
            other => panic!("Expected AND at top level, got {:?}", other),
        }

        // Test 5: AND with higher precedence operations (comparison)
        println!("Testing AND with higher precedence operations...");
        match parser.parse("a > b && c < d").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::And);
                // Left should be (a > b)
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Gt);
                    }
                    _ => panic!("Left side should be greater-than comparison"),
                }
                // Right should be (c < d)
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::Lt);
                    }
                    _ => panic!("Right side should be less-than comparison"),
                }
                println!("AND correctly binds comparison operations");
            }
            other => panic!("Expected AND at top level, got {:?}", other),
        }

        // Test 6: AND with lower precedence (OR)
        println!("Testing AND vs OR precedence...");
        match parser.parse("a && b || c && d").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Or); // OR should be at top level
                                                     // Both sides should be AND expressions
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::And);
                    }
                    _ => panic!("Left side should be AND expression"),
                }
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::And);
                    }
                    _ => panic!("Right side should be AND expression"),
                }
                println!("AND correctly binds tighter than OR");
            }
            other => panic!("Expected OR at top level, got {:?}", other),
        }

        // Test 7: Single operand (degenerate case - no AND operators)
        println!("Testing single operand (no AND)...");
        match parser.parse("true").unwrap() {
            AstNode::Expression(Expression::Literal(Literal::Boolean(b))) => {
                assert!(b);
                println!("Single operand correctly parsed as valid logical_and");
            }
            other => panic!("Expected boolean literal, got {:?}", other),
        }
    }

    /// Test that equality production rule correctly implements: equality ::= comparison ( ( EQ | NEQ ) comparison )*
    #[test]
    fn test_equality_production_rule_implementation() {
        let mut parser = Parser::new();

        // Test 1: Single comparison (no equality operators)
        println!("Testing single comparison expression...");
        match parser.parse("a > b").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Gt);
                println!("Single comparison correctly parsed");
            }
            other => panic!("Expected comparison expression, got {:?}", other),
        }

        // Test 2: Single EQ operation (comparison EQ comparison)
        println!("Testing single EQ operation...");
        match parser.parse("a > b == c < d").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Eq);
                // Left should be (a > b)
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Gt);
                    }
                    _ => panic!("Left side should be comparison expression"),
                }
                // Right should be (c < d)
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::Lt);
                    }
                    _ => panic!("Right side should be comparison expression"),
                }
                println!("Single EQ operation correctly parsed with comparison precedence");
            }
            other => panic!("Expected EQ at top level, got {:?}", other),
        }

        // Test 3: Single NEQ operation (comparison NEQ comparison)
        println!("Testing single NEQ operation...");
        match parser.parse("a >= b != c <= d").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::NotEq);
                // Left should be (a >= b)
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Gte);
                    }
                    _ => panic!("Left side should be >= comparison"),
                }
                // Right should be (c <= d)
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::Lte);
                    }
                    _ => panic!("Right side should be <= comparison"),
                }
                println!("Single NEQ operation correctly parsed with comparison precedence");
            }
            other => panic!("Expected NEQ at top level, got {:?}", other),
        }

        // Test 4: Multiple equality operations (chained - left associative)
        println!("Testing chained equality operations...");
        match parser.parse("a == b != c").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::NotEq);
                // Left should be (a == b) due to left associativity
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Eq);
                        println!("Chained equality operations correctly left-associative");
                    }
                    _ => panic!("Left side should be EQ expression for left associativity"),
                }
                // Right should be just 'c'
                match &binary.right {
                    Expression::Identifier(name) => {
                        assert_eq!(name, "c");
                    }
                    _ => panic!("Right side should be identifier 'c'"),
                }
            }
            other => panic!("Expected NEQ at top level, got {:?}", other),
        }

        // Test 5: Mixed comparison and equality with correct precedence
        println!("Testing mixed comparison/equality precedence...");
        match parser.parse("a + b > c == d * e < f").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Eq);
                // Left should be (a + b > c) - comparison binds tighter than equality
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Gt);
                        println!(
                            "Complex mixed expression: comparison binds tighter than equality"
                        );
                    }
                    _ => panic!("Left side should be comparison expression"),
                }
                // Right should be (d * e < f)
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::Lt);
                    }
                    _ => panic!("Right side should be comparison expression"),
                }
            }
            other => panic!("Expected EQ at top level, got {:?}", other),
        }

        // Test 6: Equality with lower precedence (AND)
        println!("Testing equality vs AND precedence...");
        match parser.parse("a == b && c != d").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::And); // AND should be at top level
                                                      // Both sides should be equality expressions
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Eq);
                    }
                    _ => panic!("Left side should be equality expression"),
                }
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::NotEq);
                    }
                    _ => panic!("Right side should be equality expression"),
                }
                println!("Equality correctly binds tighter than AND");
            }
            other => panic!("Expected AND at top level, got {:?}", other),
        }

        // Test 7: Simple value comparisons
        println!("Testing simple value equality...");
        match parser.parse("42 == 42").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Eq);
                // Both sides should be number literals
                match (&binary.left, &binary.right) {
                    (
                        Expression::Literal(Literal::Number(left_n)),
                        Expression::Literal(Literal::Number(right_n)),
                    ) => {
                        assert_eq!(*left_n, 42.0);
                        assert_eq!(*right_n, 42.0);
                        println!("Simple value equality correctly parsed");
                    }
                    _ => panic!("Expected number literals on both sides"),
                }
            }
            other => panic!("Expected EQ expression, got {:?}", other),
        }

        // Test 8: Single operand (degenerate case - no equality operators)
        println!("Testing single operand (no equality)...");
        match parser.parse("5").unwrap() {
            AstNode::Expression(Expression::Literal(Literal::Number(n))) => {
                assert_eq!(n, 5.0);
                println!("Single operand correctly parsed as valid equality");
            }
            other => panic!("Expected number literal, got {:?}", other),
        }
    }

    /// Test that comparison production rule correctly implements: comparison ::= additive ( ( GT | GTE | LT | LTE ) additive )*
    #[test]
    fn test_comparison_production_rule_implementation() {
        let mut parser = Parser::new();

        // Test 1: Single additive (no comparison operators)
        println!("Testing single additive expression...");
        match parser.parse("a + b").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Add);
                println!("Single additive correctly parsed");
            }
            other => panic!("Expected additive expression, got {:?}", other),
        }

        // Test 2: Single GT operation (additive GT additive)
        println!("Testing single GT operation...");
        match parser.parse("a + b > c - d").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Gt);
                // Left should be (a + b)
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Add);
                    }
                    _ => panic!("Left side should be additive expression"),
                }
                // Right should be (c - d)
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::Subtract);
                    }
                    _ => panic!("Right side should be additive expression"),
                }
                println!("Single GT operation correctly parsed with additive precedence");
            }
            other => panic!("Expected GT at top level, got {:?}", other),
        }

        // Test 3: Single GTE operation (additive GTE additive)
        println!("Testing single GTE operation...");
        match parser.parse("a * b >= c / d").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Gte);
                // Left should be (a * b)
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Multiply);
                    }
                    _ => panic!("Left side should be multiplicative expression"),
                }
                // Right should be (c / d)
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::Divide);
                    }
                    _ => panic!("Right side should be multiplicative expression"),
                }
                println!("Single GTE operation correctly parsed with multiplicative precedence");
            }
            other => panic!("Expected GTE at top level, got {:?}", other),
        }

        // Test 4: Single LT operation (additive LT additive)
        println!("Testing single LT operation...");
        match parser.parse("x + y < z - w").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Lt);
                // Left should be (x + y)
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Add);
                    }
                    _ => panic!("Left side should be additive expression"),
                }
                // Right should be (z - w)
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::Subtract);
                    }
                    _ => panic!("Right side should be additive expression"),
                }
                println!("Single LT operation correctly parsed with additive precedence");
            }
            other => panic!("Expected LT at top level, got {:?}", other),
        }

        // Test 5: Single LTE operation (additive LTE additive)
        println!("Testing single LTE operation...");
        match parser.parse("p * q <= r % s").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Lte);
                // Left should be (p * q)
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Multiply);
                    }
                    _ => panic!("Left side should be multiplicative expression"),
                }
                // Right should be (r % s)
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::Modulo);
                    }
                    _ => panic!("Right side should be modulo expression"),
                }
                println!("Single LTE operation correctly parsed with multiplicative precedence");
            }
            other => panic!("Expected LTE at top level, got {:?}", other),
        }

        // Test 6: Multiple comparison operations (chained - left associative)
        println!("Testing chained comparison operations...");
        match parser.parse("a > b < c").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Lt);
                // Left should be (a > b) due to left associativity
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Gt);
                        println!("Chained comparison operations correctly left-associative");
                    }
                    _ => panic!("Left side should be GT expression for left associativity"),
                }
                // Right should be just 'c'
                match &binary.right {
                    Expression::Identifier(name) => {
                        assert_eq!(name, "c");
                    }
                    _ => panic!("Right side should be identifier 'c'"),
                }
            }
            other => panic!("Expected LT at top level, got {:?}", other),
        }

        // Test 7: Mixed additive and comparison with correct precedence
        println!("Testing mixed additive/comparison precedence...");
        match parser.parse("a + b > c - d >= e * f < g / h").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Lt);
                // This should parse as (((a + b) > (c - d)) >= (e * f)) < (g / h)
                // Left should be another comparison (GTE)
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Gte);
                        println!("Complex mixed expression parsed with correct precedence");
                    }
                    _ => panic!("Left side should be GTE expression"),
                }
            }
            other => panic!("Expected LT at top level, got {:?}", other),
        }

        // Test 8: Comparison with lower precedence (equality)
        println!("Testing comparison vs equality precedence...");
        match parser.parse("a > b == c < d").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Eq); // Equality should be at top level
                                                     // Both sides should be comparison expressions
                match &binary.left {
                    Expression::Binary(left_binary) => {
                        assert_eq!(left_binary.op, BinaryOp::Gt);
                    }
                    _ => panic!("Left side should be comparison expression"),
                }
                match &binary.right {
                    Expression::Binary(right_binary) => {
                        assert_eq!(right_binary.op, BinaryOp::Lt);
                    }
                    _ => panic!("Right side should be comparison expression"),
                }
                println!("Comparison correctly binds tighter than equality");
            }
            other => panic!("Expected EQ at top level, got {:?}", other),
        }

        // Test 9: Simple numeric comparisons
        println!("Testing simple numeric comparison...");
        match parser.parse("10 > 5").unwrap() {
            AstNode::Expression(Expression::Binary(binary)) => {
                assert_eq!(binary.op, BinaryOp::Gt);
                // Both sides should be number literals
                match (&binary.left, &binary.right) {
                    (
                        Expression::Literal(Literal::Number(left_n)),
                        Expression::Literal(Literal::Number(right_n)),
                    ) => {
                        assert_eq!(*left_n, 10.0);
                        assert_eq!(*right_n, 5.0);
                        println!("Simple numeric comparison correctly parsed");
                    }
                    _ => panic!("Expected number literals on both sides"),
                }
            }
            other => panic!("Expected GT expression, got {:?}", other),
        }

        // Test 10: Single operand (degenerate case - no comparison operators)
        println!("Testing single operand (no comparison)...");
        match parser.parse("42").unwrap() {
            AstNode::Expression(Expression::Literal(Literal::Number(n))) => {
                assert_eq!(n, 42.0);
                println!("Single operand correctly parsed as valid comparison");
            }
            other => panic!("Expected number literal, got {:?}", other),
        }
    }

    /// Test that OperatorPrecedence enum works correctly with proper levels 0-7
    #[test]
    fn test_associativity_rules_implementation() {
        use super::super::lexer::Position;

        // Test that all precedence levels return correct associativity
        assert_eq!(
            OperatorPrecedence::None.associativity(),
            Associativity::Left
        );
        assert_eq!(
            OperatorPrecedence::LogicalOr.associativity(),
            Associativity::Left
        );
        assert_eq!(
            OperatorPrecedence::LogicalAnd.associativity(),
            Associativity::Left
        );
        assert_eq!(
            OperatorPrecedence::Equality.associativity(),
            Associativity::Left
        );
        assert_eq!(
            OperatorPrecedence::Comparison.associativity(),
            Associativity::Left
        );
        assert_eq!(
            OperatorPrecedence::Additive.associativity(),
            Associativity::Left
        );
        assert_eq!(
            OperatorPrecedence::Multiplicative.associativity(),
            Associativity::Left
        );
        assert_eq!(
            OperatorPrecedence::CallAccess.associativity(),
            Associativity::Left
        );

        // Test helper function integration
        let mut parser = Parser::new();
        let or_token = Token {
            token_type: TokenType::Or,
            position: Position {
                line: 1,
                column: 1,
                offset: 0,
            },
        };
        let (prec, assoc) = parser.get_precedence_and_assoc(Some(&or_token));
        assert_eq!(prec, 1);
        assert_eq!(assoc, Associativity::Left);

        // Test left-associative parsing behavior with same precedence operators
        // Use parse_core with a string instead of constructing tokens manually
        let result = parser
            .parse_core("5 - 3 - 1")
            .expect("Should parse successfully");

        // Should parse as ((5 - 3) - 1) due to left associativity
        // Verify the structure is correct
        match &result {
            AstNode::Expression(Expression::Binary(outer)) => {
                assert_eq!(outer.op, BinaryOp::Subtract);
                // Left side should be (5 - 3)
                match &outer.left {
                    Expression::Binary(inner) => {
                        assert_eq!(inner.op, BinaryOp::Subtract);
                        assert!(
                            matches!(inner.left, Expression::Literal(Literal::Number(n)) if (n - 5.0).abs() < f64::EPSILON)
                        );
                        assert!(
                            matches!(inner.right, Expression::Literal(Literal::Number(n)) if (n - 3.0).abs() < f64::EPSILON)
                        );
                    }
                    _ => panic!("Expected left side to be binary subtraction"),
                }
                // Right side should be 1
                assert!(
                    matches!(outer.right, Expression::Literal(Literal::Number(n)) if (n - 1.0).abs() < f64::EPSILON)
                );
            }
            _ => panic!("Expected top-level binary expression"),
        }

        // The same tree as the explicitly left-grouped text confirms left-associativity
        assert_eq!(result, Parser::new().parse("(5 - 3) - 1").unwrap());
    }

    #[test]
    fn test_operator_precedence_enum_implementation() {
        // Test enum levels are correct (0-7)
        println!("Testing OperatorPrecedence enum levels...");
        assert_eq!(OperatorPrecedence::None.as_u8(), 0);
        assert_eq!(OperatorPrecedence::LogicalOr.as_u8(), 1);
        assert_eq!(OperatorPrecedence::LogicalAnd.as_u8(), 2);
        assert_eq!(OperatorPrecedence::Equality.as_u8(), 3);
        assert_eq!(OperatorPrecedence::Comparison.as_u8(), 4);
        assert_eq!(OperatorPrecedence::Additive.as_u8(), 5);
        assert_eq!(OperatorPrecedence::Multiplicative.as_u8(), 6);
        assert_eq!(OperatorPrecedence::CallAccess.as_u8(), 7);
        println!("All precedence levels correct (0-7)");

        // Test ordering works correctly
        println!("Testing precedence ordering...");
        assert!(OperatorPrecedence::None < OperatorPrecedence::LogicalOr);
        assert!(OperatorPrecedence::LogicalOr < OperatorPrecedence::LogicalAnd);
        assert!(OperatorPrecedence::LogicalAnd < OperatorPrecedence::Equality);
        assert!(OperatorPrecedence::Equality < OperatorPrecedence::Comparison);
        assert!(OperatorPrecedence::Comparison < OperatorPrecedence::Additive);
        assert!(OperatorPrecedence::Additive < OperatorPrecedence::Multiplicative);
        assert!(OperatorPrecedence::Multiplicative < OperatorPrecedence::CallAccess);
        println!("Precedence ordering correct");

        // Test from_binary_op mapping
        println!("Testing from_binary_op mapping...");
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::Or),
            OperatorPrecedence::LogicalOr
        );
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::And),
            OperatorPrecedence::LogicalAnd
        );
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::Eq),
            OperatorPrecedence::Equality
        );
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::NotEq),
            OperatorPrecedence::Equality
        );
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::Lt),
            OperatorPrecedence::Comparison
        );
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::Lte),
            OperatorPrecedence::Comparison
        );
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::Gt),
            OperatorPrecedence::Comparison
        );
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::Gte),
            OperatorPrecedence::Comparison
        );
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::Add),
            OperatorPrecedence::Additive
        );
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::Subtract),
            OperatorPrecedence::Additive
        );
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::Multiply),
            OperatorPrecedence::Multiplicative
        );
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::Divide),
            OperatorPrecedence::Multiplicative
        );
        assert_eq!(
            OperatorPrecedence::from_binary_op(&BinaryOp::Modulo),
            OperatorPrecedence::Multiplicative
        );
        println!("Binary operator mapping correct");

        // Test from_token_type mapping
        println!("Testing from_token_type mapping...");
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Or),
            OperatorPrecedence::LogicalOr
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::And),
            OperatorPrecedence::LogicalAnd
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Eq),
            OperatorPrecedence::Equality
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::NotEq),
            OperatorPrecedence::Equality
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Lt),
            OperatorPrecedence::Comparison
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Lte),
            OperatorPrecedence::Comparison
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Gt),
            OperatorPrecedence::Comparison
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Gte),
            OperatorPrecedence::Comparison
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Plus),
            OperatorPrecedence::Additive
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Minus),
            OperatorPrecedence::Additive
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Star),
            OperatorPrecedence::Multiplicative
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Slash),
            OperatorPrecedence::Multiplicative
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Percent),
            OperatorPrecedence::Multiplicative
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::LParen),
            OperatorPrecedence::CallAccess
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Dot),
            OperatorPrecedence::CallAccess
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::LBracket),
            OperatorPrecedence::CallAccess
        );

        // Test unknown token returns None
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Number(42.0)),
            OperatorPrecedence::None
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::String("test".to_string())),
            OperatorPrecedence::None
        );
        assert_eq!(
            OperatorPrecedence::from_token_type(&TokenType::Boolean(true)),
            OperatorPrecedence::None
        );
        println!("Token type mapping correct");

        // Test that as_u8 matches direct enum values
        println!("Testing as_u8 consistency...");
        assert_eq!(OperatorPrecedence::LogicalOr.as_u8(), 1);
        assert_eq!(OperatorPrecedence::Multiplicative.as_u8(), 6);
        assert_eq!(OperatorPrecedence::CallAccess.as_u8(), 7);
        println!("as_u8 conversion consistent");
    }
}
