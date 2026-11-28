//! A small JavaScript-compatible regular-expression subset for status rules.
//!
//! `StatusRule.op = matches` calls `new RegExp(pattern, "u").test(value)` in
//! `StepExecutor.evaluateAssertion`. The Rust workspace does not pin a regex crate, so the flow
//! engine carries this deterministic matcher instead of adding a dependency outside
//! `[workspace.dependencies]` (recorded in `README.md`).
//!
//! Supported syntax: literals, `.`, escapes (`\d \D \w \W \s \S \n \r \t \0 \uXXXX` and any escaped
//! punctuation), character classes (`[a-z0-9_]`, negation `[^...]`), groups (`(...)`, `(?:...)`),
//! alternation (`|`), anchors `^`/`$`, and the quantifiers `* + ? {m} {m,} {m,n}` with an optional
//! lazy `?` (laziness does not change `test`, only where the match ends).
//!
//! Not supported (a spec that uses them is refused as `UNSUPPORTED_PATTERN`): lookaround
//! (`(?=`, `(?!`, `(?<=`, `(?<!`), backreferences (`\1`), named groups, flags other than `u`, and
//! Unicode property escapes (`\p{...}`). A pattern without a match anchor is searched anywhere,
//! like `RegExp.test`.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

/// A compiled pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsRegex {
    root: Node,
    starts_anchored: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Empty,
    Char(char),
    Any,
    Class(CharClass),
    Start,
    End,
    Concat(Vec<Node>),
    Alt(Vec<Node>),
    Repeat {
        node: Box<Node>,
        min: u32,
        max: Option<u32>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CharClass {
    negated: bool,
    items: Vec<ClassItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ClassItem {
    Char(char),
    Range(char, char),
    Digit,
    NotDigit,
    Word,
    NotWord,
    Space,
    NotSpace,
}

/// Why a pattern was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegexError {
    Empty,
    UnterminatedGroup,
    UnterminatedClass,
    Unsupported,
    NothingToRepeat,
    InvalidQuantifier,
    InvalidEscape,
    TooComplex,
}

impl std::fmt::Display for RegexError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Empty => "regular expression is empty",
            Self::UnterminatedGroup => "unterminated group",
            Self::UnterminatedClass => "unterminated character class",
            Self::Unsupported => "regular expression uses an unsupported construct",
            Self::NothingToRepeat => "nothing to repeat",
            Self::InvalidQuantifier => "invalid quantifier",
            Self::InvalidEscape => "invalid escape",
            Self::TooComplex => "regular expression is too complex",
        })
    }
}

impl std::error::Error for RegexError {}

impl JsRegex {
    /// Compile a pattern. An empty pattern is the JavaScript empty regex, which matches every
    /// string; it is refused here because a status rule with an empty selector is a spec bug.
    pub fn new(pattern: &str) -> Result<Self, RegexError> {
        if pattern.is_empty() {
            return Err(RegexError::Empty);
        }
        let chars: Vec<char> = pattern.chars().collect();
        let mut parser = Parser {
            chars,
            position: 0,
            depth: 0,
        };
        let root = parser.parse_alternation()?;
        if parser.position != parser.chars.len() {
            return Err(RegexError::UnterminatedGroup);
        }
        let starts_anchored = starts_with_anchor(&root);
        Ok(Self {
            root,
            starts_anchored,
        })
    }

    /// `RegExp.test`: true when the pattern matches anywhere in the value.
    #[must_use]
    pub fn is_match(&self, value: &str) -> bool {
        let text: Vec<char> = value.chars().collect();
        let start = 0;
        let end = text.len();
        if self.starts_anchored {
            return !ends(&self.root, &text, start, end).is_empty();
        }
        for index in start..=end {
            if !ends(&self.root, &text, index, end).is_empty() {
                return true;
            }
        }
        false
    }
}

fn starts_with_anchor(node: &Node) -> bool {
    match node {
        Node::Start => true,
        Node::Concat(children) => children.first().is_some_and(starts_with_anchor),
        Node::Alt(children) => children.iter().all(starts_with_anchor),
        Node::Repeat { node, min, .. } => *min > 0 && starts_with_anchor(node),
        _ => false,
    }
}

struct Parser {
    chars: Vec<char>,
    position: usize,
    depth: u8,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.position).copied()
    }

    fn next(&mut self) -> Option<char> {
        let value = self.peek();
        if value.is_some() {
            self.position += 1;
        }
        value
    }

    fn eat(&mut self, expected: char) -> bool {
        if self.peek() == Some(expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn parse_alternation(&mut self) -> Result<Node, RegexError> {
        let mut branches = Vec::new();
        loop {
            let branch = self.parse_sequence()?;
            branches.push(branch);
            if !self.eat('|') {
                break;
            }
        }
        Ok(if branches.len() == 1 {
            branches.pop().unwrap_or(Node::Empty)
        } else {
            Node::Alt(branches)
        })
    }

    fn parse_sequence(&mut self) -> Result<Node, RegexError> {
        let mut items = Vec::new();
        while let Some(character) = self.peek() {
            if character == '|' || character == ')' {
                break;
            }
            let atom = self.parse_atom()?;
            let atom = self.parse_quantifier(atom)?;
            items.push(atom);
        }
        Ok(match items.len() {
            0 => Node::Empty,
            1 => items.pop().unwrap_or(Node::Empty),
            _ => Node::Concat(items),
        })
    }

    fn parse_atom(&mut self) -> Result<Node, RegexError> {
        let character = self.next().ok_or(RegexError::Unsupported)?;
        match character {
            '^' => Ok(Node::Start),
            '$' => Ok(Node::End),
            '.' => Ok(Node::Any),
            '(' => {
                self.depth = self.depth.saturating_add(1);
                if self.depth > 32 {
                    return Err(RegexError::TooComplex);
                }
                // Non-capturing and named groups are accepted only in their `(?:` form; lookaround
                // starts with `(?` too and must be refused.
                if self.peek() == Some('?') {
                    let mut lookahead = self.chars.iter().skip(self.position).take(2).copied();
                    let first = lookahead.next();
                    let second = lookahead.next();
                    if first == Some('?') && second == Some(':') {
                        self.position += 2;
                    } else {
                        return Err(RegexError::Unsupported);
                    }
                }
                let inner = self.parse_alternation()?;
                if !self.eat(')') {
                    return Err(RegexError::UnterminatedGroup);
                }
                self.depth = self.depth.saturating_sub(1);
                Ok(inner)
            }
            ')' => Err(RegexError::UnterminatedGroup),
            '[' => self.parse_class(),
            '\\' => self.parse_escape(),
            '*' | '+' | '?' => Err(RegexError::NothingToRepeat),
            '{' => Err(RegexError::NothingToRepeat),
            literal => Ok(Node::Char(literal)),
        }
    }

    fn parse_quantifier(&mut self, atom: Node) -> Result<Node, RegexError> {
        let Some(character) = self.peek() else {
            return Ok(atom);
        };
        let (min, max) = match character {
            '*' => {
                self.position += 1;
                (0, None)
            }
            '+' => {
                self.position += 1;
                (1, None)
            }
            '?' => {
                self.position += 1;
                (0, Some(1))
            }
            '{' => {
                self.position += 1;
                let min = self.parse_number()?;
                let max = if self.eat(',') {
                    if self.peek() == Some('}') {
                        None
                    } else {
                        Some(self.parse_number()?)
                    }
                } else {
                    Some(min)
                };
                if !self.eat('}') {
                    return Err(RegexError::InvalidQuantifier);
                }
                if let Some(max) = max {
                    if max < min {
                        return Err(RegexError::InvalidQuantifier);
                    }
                }
                if min > 1000 {
                    return Err(RegexError::TooComplex);
                }
                (min, max)
            }
            _ => return Ok(atom),
        };
        if matches!(atom, Node::Start | Node::End | Node::Empty) {
            return Err(RegexError::NothingToRepeat);
        }
        // A lazy quantifier (`*?`) changes the preferred end of a match, not whether `test` matches.
        if self.peek() == Some('?') {
            self.position += 1;
        }
        Ok(Node::Repeat {
            node: Box::new(atom),
            min,
            max,
        })
    }

    fn parse_number(&mut self) -> Result<u32, RegexError> {
        let mut digits = String::new();
        while let Some(character) = self.peek() {
            if character.is_ascii_digit() {
                digits.push(character);
                self.position += 1;
            } else {
                break;
            }
        }
        if digits.is_empty() {
            return Err(RegexError::InvalidQuantifier);
        }
        digits
            .parse::<u32>()
            .map_err(|_| RegexError::InvalidQuantifier)
    }

    fn parse_class(&mut self) -> Result<Node, RegexError> {
        let negated = self.eat('^');
        let mut items = Vec::new();
        let mut first = true;
        loop {
            let Some(character) = self.next() else {
                return Err(RegexError::UnterminatedClass);
            };
            if character == ']' && !first {
                break;
            }
            first = false;
            let item = if character == '\\' {
                self.parse_class_escape()?
            } else {
                ClassItem::Char(character)
            };
            // A range is only valid when both ends are plain characters and no `-` ends the class.
            if let ClassItem::Char(start) = item {
                if self.peek() == Some('-')
                    && self
                        .chars
                        .get(self.position + 1)
                        .is_some_and(|next| *next != ']')
                {
                    self.position += 1;
                    let end_character = self.next().ok_or(RegexError::UnterminatedClass)?;
                    let end = if end_character == '\\' {
                        match self.parse_class_escape()? {
                            ClassItem::Char(value) => value,
                            _ => return Err(RegexError::InvalidEscape),
                        }
                    } else {
                        end_character
                    };
                    items.push(ClassItem::Range(start, end));
                    continue;
                }
                items.push(ClassItem::Char(start));
                continue;
            }
            items.push(item);
        }
        Ok(Node::Class(CharClass { negated, items }))
    }

    fn parse_class_escape(&mut self) -> Result<ClassItem, RegexError> {
        let character = self.next().ok_or(RegexError::InvalidEscape)?;
        Ok(match character {
            'd' => ClassItem::Digit,
            'D' => ClassItem::NotDigit,
            'w' => ClassItem::Word,
            'W' => ClassItem::NotWord,
            's' => ClassItem::Space,
            'S' => ClassItem::NotSpace,
            'n' => ClassItem::Char('\n'),
            'r' => ClassItem::Char('\r'),
            't' => ClassItem::Char('\t'),
            '0' => ClassItem::Char('\0'),
            'u' => {
                let mut hex = String::new();
                for _ in 0..4 {
                    hex.push(self.next().ok_or(RegexError::InvalidEscape)?);
                }
                let value = u32::from_str_radix(&hex, 16).map_err(|_| RegexError::InvalidEscape)?;
                ClassItem::Char(char::from_u32(value).ok_or(RegexError::InvalidEscape)?)
            }
            other => ClassItem::Char(other),
        })
    }

    fn parse_escape(&mut self) -> Result<Node, RegexError> {
        let character = self.next().ok_or(RegexError::InvalidEscape)?;
        Ok(match character {
            'd' => Node::Class(CharClass {
                negated: false,
                items: vec![ClassItem::Digit],
            }),
            'D' => Node::Class(CharClass {
                negated: false,
                items: vec![ClassItem::NotDigit],
            }),
            'w' => Node::Class(CharClass {
                negated: false,
                items: vec![ClassItem::Word],
            }),
            'W' => Node::Class(CharClass {
                negated: false,
                items: vec![ClassItem::NotWord],
            }),
            's' => Node::Class(CharClass {
                negated: false,
                items: vec![ClassItem::Space],
            }),
            'S' => Node::Class(CharClass {
                negated: false,
                items: vec![ClassItem::NotSpace],
            }),
            'n' => Node::Char('\n'),
            'r' => Node::Char('\r'),
            't' => Node::Char('\t'),
            '0' => Node::Char('\0'),
            'u' => {
                let mut hex = String::new();
                for _ in 0..4 {
                    hex.push(self.next().ok_or(RegexError::InvalidEscape)?);
                }
                let value = u32::from_str_radix(&hex, 16).map_err(|_| RegexError::InvalidEscape)?;
                Node::Char(char::from_u32(value).ok_or(RegexError::InvalidEscape)?)
            }
            'b' | 'B' => return Err(RegexError::Unsupported),
            'p' | 'P' => return Err(RegexError::Unsupported),
            '1'..='9' => return Err(RegexError::Unsupported),
            other => Node::Char(other),
        })
    }
}

fn is_word(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

fn is_space(character: char) -> bool {
    matches!(
        character,
        ' ' | '\t'
            | '\n'
            | '\u{000B}'
            | '\u{000C}'
            | '\r'
            | '\u{0085}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

impl CharClass {
    fn matches(&self, character: char) -> bool {
        let hit = self.items.iter().any(|item| match item {
            ClassItem::Char(value) => *value == character,
            ClassItem::Range(start, end) => (*start..=*end).contains(&character),
            ClassItem::Digit => character.is_ascii_digit(),
            ClassItem::NotDigit => !character.is_ascii_digit(),
            ClassItem::Word => is_word(character),
            ClassItem::NotWord => !is_word(character),
            ClassItem::Space => is_space(character),
            ClassItem::NotSpace => !is_space(character),
        });
        hit != self.negated
    }
}

fn ends(node: &Node, text: &[char], position: usize, len: usize) -> Vec<usize> {
    match node {
        Node::Empty => vec![position],
        Node::Start => {
            if position == 0 {
                vec![position]
            } else {
                Vec::new()
            }
        }
        Node::End => {
            // JavaScript `$` also matches immediately before a final line terminator.
            if position == len
                || (position + 1 == len
                    && text
                        .get(position)
                        .is_some_and(|character| *character == '\n'))
            {
                vec![position]
            } else {
                Vec::new()
            }
        }
        Node::Char(expected) => {
            if text.get(position) == Some(expected) {
                vec![position + 1]
            } else {
                Vec::new()
            }
        }
        Node::Any => match text.get(position) {
            Some(character) if !matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}') => {
                vec![position + 1]
            }
            _ => Vec::new(),
        },
        Node::Class(class) => match text.get(position) {
            Some(character) if class.matches(*character) => vec![position + 1],
            _ => Vec::new(),
        },
        Node::Concat(children) => {
            let mut positions = vec![position];
            for child in children {
                let mut next = BTreeSet::new();
                for current in positions {
                    for end in ends(child, text, current, len) {
                        next.insert(end);
                    }
                }
                positions = next.into_iter().collect();
                if positions.is_empty() {
                    return positions;
                }
            }
            positions
        }
        Node::Alt(children) => {
            let mut positions = BTreeSet::new();
            for child in children {
                for end in ends(child, text, position, len) {
                    positions.insert(end);
                }
            }
            positions.into_iter().collect()
        }
        Node::Repeat { node, min, max } => {
            let limit = max.unwrap_or(u32::try_from(len + 1).unwrap_or(u32::MAX)) as usize;
            let mut reachable: BTreeSet<usize> = BTreeSet::new();
            reachable.insert(position);
            let mut results = BTreeSet::new();
            if *min == 0 {
                results.insert(position);
            }
            for count in 1..=limit {
                let mut next = BTreeSet::new();
                for current in &reachable {
                    for end in ends(node, text, *current, len) {
                        next.insert(end);
                    }
                }
                if next.is_empty() {
                    break;
                }
                if count >= *min as usize {
                    results.extend(next.iter().copied());
                }
                // A repetition that cannot advance would loop forever.
                if next.iter().all(|end| *end == position) {
                    break;
                }
                reachable = next;
            }
            results.into_iter().collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(pattern: &str, value: &str) -> bool {
        JsRegex::new(pattern).expect("pattern").is_match(value)
    }

    #[test]
    fn anchors_and_literals() {
        assert!(matches("^SUCCESS$", "SUCCESS"));
        assert!(!matches("^SUCCESS$", "SUCCESSFUL"));
        assert!(!matches("^SUCCESS$", " NOTSUCCESS"));
        assert!(matches("SUCCESS", "the status is SUCCESS today"));
    }

    #[test]
    fn character_classes_and_escapes() {
        assert!(matches(r"^\d{1,3}$", "007"));
        assert!(!matches(r"^\d{1,3}$", "1234"));
        assert!(matches(r"^[A-Z]{2}\d+$", "LY123"));
        assert!(matches(r"^[^0-9]+$", "declined"));
        assert!(matches(r"^\w+@\w+\.\w+$", "a_b@example.ly"));
        assert!(matches(r"^\s*ok\s*$", "  ok "));
    }

    #[test]
    fn alternation_groups_and_optional_parts() {
        assert!(matches("^(00|99)$", "99"));
        assert!(!matches("^(00|99)$", "01"));
        assert!(matches("^(?:APPROVED|CAPTURED)$", "CAPTURED"));
        assert!(matches("^colou?r$", "color"));
        assert!(matches("^colou?r$", "colour"));
        assert!(matches("^ab*c$", "ac"));
        assert!(matches("^ab*c$", "abbbc"));
        assert!(matches("^a{2,3}$", "aaa"));
        assert!(!matches("^a{2,3}$", "aaaa"));
    }

    #[test]
    fn unsupported_constructs_are_refused() {
        assert_eq!(JsRegex::new("(?=abc)"), Err(RegexError::Unsupported));
        assert_eq!(JsRegex::new("(?!abc)"), Err(RegexError::Unsupported));
        assert_eq!(JsRegex::new(r"(a)\1"), Err(RegexError::Unsupported));
        assert_eq!(JsRegex::new("[a-z"), Err(RegexError::UnterminatedClass));
        assert_eq!(JsRegex::new("(a"), Err(RegexError::UnterminatedGroup));
        assert_eq!(JsRegex::new("*"), Err(RegexError::NothingToRepeat));
        assert_eq!(JsRegex::new(""), Err(RegexError::Empty));
    }

    #[test]
    fn unicode_code_points_match_the_u_flag() {
        assert!(matches("^مرحبا$", "مرحبا"));
        assert!(matches("^.}$", "ا}"));
    }
}
