//! Live record-model checks over supplied canonical DATA and logical values.
//! This pure model opens no source and grants no write, key, or account right.
//! The original envelope owner supplies current declarations and the effective
//! ordered states of a batch; no-op envelopes must not move a declaration winner.
//! Source: parts/record-log/do-work/record-model.mjs and record-log-store.mjs.
use crate::ecma_json::{self, JsString, Value};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) mod write_command;

#[derive(Clone, Debug)]
pub enum Error { InvalidModel(crate::refusal_cause::Cause), Bounds(crate::refusal_cause::Cause)}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::InvalidModel(cause) => cause.clone(),
            Self::Bounds(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);

// Equality keeps the domain classification; source identity is compared explicitly via cause().
impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// Names are private user data; Debug never includes a refused field/value.
#[derive(Clone)]
pub struct Refusal {
    pub cause: crate::refusal_cause::Cause,
    /// The declaration whose field refused the change, including a field released by a kind change.
    pub kind: JsString,
    pub property: JsString,
    pub expected: JsString,
    /// With a declared set of choices: the value that is outside them (text; an array's offending element). With
    /// declared moves: the value the write changes to.
    pub outside: Option<JsString>,
    /// With declared moves: the value the write changes from (`START_OF_MOVES` for a field that held no value), when
    /// the change from it to `outside` is not one of the moves.
    pub from: Option<JsString>,
}
impl Refusal { pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause.clone() } }
crate::impl_caused!(Refusal);

impl PartialEq for Refusal {
    fn eq(&self, other: &Self) -> bool {
        self.kind == other.kind && self.property == other.property && self.expected == other.expected
            && self.outside == other.outside && self.from == other.from
    }
}
impl Eq for Refusal {}
impl std::fmt::Debug for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("ModelRefusal([redacted])") }
}
#[derive(Clone, Default)]
struct Kind { properties: BTreeMap<JsString, JsString> }
#[derive(Clone)]
struct Rule { named: Vec<JsString>, prefix: JsString, fields: Vec<JsString>, name: Vec<JsString>, kind: Vec<JsString>, choices: Option<Vec<JsString>>, moves: Option<Vec<JsString>>, kinds: BTreeMap<JsString, Value>, indexes: Option<Vec<JsString>> }
#[derive(Clone)]
struct Declaration { kind: JsString, properties: BTreeMap<JsString, JsString>, choices: BTreeMap<JsString, Vec<JsString>>, moves: BTreeMap<JsString, Moves>, marks: BTreeMap<JsString, Vec<JsString>> }

/// The generic field mark a declaring record (a list) may give one of its fields: the values a write may set only
/// with a fresh confirmation by the person present (`account::person_present`). It is DATA in the declaring record
/// itself; the model names no list, field or value.
pub const PERSON_PRESENT_MARK: &str = "needs_person_present_to_set";

/// The moves a declaring record gives one field: each value the field may change FROM, and the values it may change
/// to from there. The declaring record writes them as an object, e.g. `{"": ["waiting"], "waiting": ["taken",
/// "withdrawn"], "taken": ["done", "failed", "waiting"], "done": []}`:
/// - the key `START_OF_MOVES` ("") is the field holding no value (a new row, a row without the field, or null), so its
///   list is the values a row may start in;
/// - a value with an empty list is final: nothing may change it;
/// - a value that is not a key (the start included) may change to another supplied value; releasing a held value
///   still needs an explicit move to "";
/// - null or omitting a held field releases it only when the moves from its held value list "". A kind change
///   releases the old kind's fields by the same rule. Removing a whole record remains the record deletion owner's
///   operation, with its own rights and confirmation checks.
///
/// An unchanged value is never checked. The path of a field definition's moves is DATA (the rule's
/// `properties.moves`); the model names no list, field or value.
pub type Moves = BTreeMap<JsString, Vec<JsString>>;

/// The moves key for a field that holds no value (see `Moves`).
pub const START_OF_MOVES: &str = "";

/// One (declared row kind, field, value) a declaring record marks as needing the person present to set.
pub type Mark = (JsString, JsString, JsString);

/// Shipped DATA plus the current record-declared model. Guard properties are
/// intentionally absent: original live stores never constrain writes by them.
#[derive(Clone, Default)]
pub struct Model {
    shipped: BTreeMap<JsString, Kind>,
    value_kinds: BTreeMap<JsString, Value>,
    rules: BTreeMap<JsString, Rule>,
    rule_order: Vec<JsString>,
    by_record: BTreeMap<JsString, Declaration>,
    by_type: BTreeMap<JsString, JsString>,
    erasable: BTreeMap<JsString, Vec<Vec<JsString>>>,
    key_paths: BTreeMap<JsString, Vec<JsString>>,
}
impl std::fmt::Debug for Model {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("RecordWriteModel([redacted])") }
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> { member(value, &name.into()) }
fn member<'a>(value: &'a Value, key: &JsString) -> Option<&'a Value> { match value { Value::Object(o)=>o.get(key),_=>None } }
fn text(value: Option<&Value>) -> Option<&JsString> { match value {Some(Value::String(s))=>Some(s),_=>None} }
fn array(value: Option<&Value>) -> &[Value] { match value {Some(Value::Array(v))=>v,_=>&[]} }
fn entries(value: Option<&Value>) -> Vec<(&JsString,&Value)> { match value {Some(Value::Object(o))=>o.property_entries(),_=>Vec::new()} }
fn nonempty(value: Option<&Value>) -> Result<JsString> { text(value).filter(|s|!s.is_empty()).cloned().ok_or(crate::cause!(Error::InvalidModel)) }
fn path(value: Option<&Value>) -> Result<Vec<JsString>> {
    match value {Some(Value::Array(v))=>v.iter().map(|v|text(Some(v)).cloned().ok_or(crate::cause!(Error::InvalidModel))).collect(),_=>Err(crate::cause!(Error::InvalidModel))}
}
fn field_path(value: &Value) -> Result<Vec<JsString>> {
    match value { Value::String(s)=>Ok(vec![s.clone()]),Value::Array(_)=>path(Some(value)),_=>Err(crate::cause!(Error::InvalidModel)) }
}
fn at<'a>(value: &'a Value, path: &[JsString]) -> Option<&'a Value> { let mut here=value;for key in path {here=member(here,key)?;}Some(here) }
fn properties(value: Option<&Value>) -> Result<BTreeMap<JsString,JsString>> { entries(value).into_iter().map(|(k,v)|Ok((k.clone(),text(Some(v)).cloned().ok_or(crate::cause!(Error::InvalidModel))?))).collect() }
fn same_json(a: &Value,b: &Value) -> Result<bool> { Ok(ecma_json::stringify(a,Default::default()).map_err(|error| Error::Bounds(error.cause()))?==ecma_json::stringify(b,Default::default()).map_err(|error| Error::Bounds(error.cause()))?) }
fn truthy(v:&Value)->bool {match v {Value::Null|Value::Bool(false)=>false,Value::Number(n)=>*n!=0.0&&!n.is_nan(),Value::String(s)=>!s.is_empty(),_=>true}}
fn ascii(value:&JsString, expected:&str)->bool { value.units().iter().copied().eq(expected.encode_utf16()) }
fn is_id(value:&Value)->bool {matches!(value,Value::String(s) if !s.is_empty()&&!s.units().contains(&0)&&!s.units().contains(&(b'/' as u16)))}
fn fits_is(shape:&JsString,value:&Value)->bool {
    if ascii(shape,"string"){matches!(value,Value::String(_))}
    else if ascii(shape,"number"){matches!(value,Value::Number(n) if n.is_finite())}
    else if ascii(shape,"boolean"){matches!(value,Value::Bool(_))}
    else if ascii(shape,"object"){matches!(value,Value::Object(_))}
    else if ascii(shape,"list"){matches!(value,Value::Array(_))}
    else if ascii(shape,"id"){is_id(value)}else{true}
}
/// Mirrors fitsKind: null always fits; unknown shapes constrain nothing.
fn fits_kind(shape:Option<&Value>,value:&Value)->bool {
    if matches!(value,Value::Null){return true}
    let Some(shape)=shape else{return true};
    if let Some(list)=field(shape,"list_of").filter(|v|truthy(v)) {
        return match value {Value::Array(items)=>text(Some(list)).is_none_or(|kind|items.iter().all(|v|fits_is(kind,v))),_=>false}
    }
    text(field(shape,"is")).is_none_or(|kind|fits_is(kind,value))
}
/// The value (or an array's first element) that is not one of `allowed`; null releases a value and fits. Anything that
/// is not text is outside a declared set of text choices.
fn outside_choices(allowed:&[JsString],value:&Value)->Option<JsString> {
    let outside=|one:&Value|match one {Value::Null=>None,Value::String(s) if allowed.contains(s)=>None,other=>Some(js_key(other))};
    match value {Value::Array(items)=>items.iter().find_map(outside),one=>outside(one)}
}
/// The value a change from `held` to `value` moves from when `moves` lists no such move (see `Moves`); None when the
/// move is listed or moves do not restrict a change from `held`. Missing and null both mean no field value.
fn move_not_declared(moves:&Moves,held:Option<&Value>,value:Option<&Value>)->Option<JsString> {
    if matches!(held,None|Some(Value::Null))&&matches!(value,None|Some(Value::Null)){return None}
    let from=match held {None|Some(Value::Null)=>JsString::from(START_OF_MOVES),Some(one)=>js_key(one)};
    let listed=match moves.get(&from){Some(listed)=>listed,None if matches!(value,None|Some(Value::Null))=>return Some(from),None=>return None};
    let to=match value {None|Some(Value::Null)=>Some(JsString::from(START_OF_MOVES)),Some(Value::String(to))=>Some(to.clone()),_=>None};
    if to.as_ref().is_some_and(|to|listed.contains(to)){None}else{Some(from)}
}
/// The text values a field definition marks with `PERSON_PRESENT_MARK` (anything else in that list marks nothing).
fn marked_values(field_value:&Value)->Vec<JsString> {
    array(field(field_value,PERSON_PRESENT_MARK)).iter().filter_map(|v|text(Some(v)).cloned()).collect()
}
fn js_key(value:&Value)->JsString {
    match value {
        Value::String(s)=>s.clone(),Value::Null=>"null".into(),Value::Bool(true)=>"true".into(),Value::Bool(false)=>"false".into(),
        Value::Object(_)=>"[object Object]".into(),
        Value::Number(n)=>{if n.is_nan(){"NaN".into()}else if *n==f64::INFINITY{"Infinity".into()}else if *n==f64::NEG_INFINITY{"-Infinity".into()}else{let mut b=ryu_js::Buffer::new();b.format(*n).into()}},
        Value::Array(items)=>{let mut out=Vec::new();for (n,v) in items.iter().enumerate(){if n>0{out.push(b',' as u16)}if !matches!(v,Value::Null){out.extend_from_slice(js_key(v).units());}}JsString::from_units(out)},
    }
}

impl Model {
    pub fn from_data(data:&Value)->Result<Self> {
        if !matches!(data,Value::Object(_)){return Err(crate::cause!(Error::InvalidModel))}
        ecma_json::stringify(data,Default::default()).map_err(|error| Error::Bounds(error.cause()))?;
        let mut out=Self::default();
        out.value_kinds=entries(field(data,"value_kinds")).into_iter().map(|(k,v)|(k.clone(),v.clone())).collect();
        for row in array(field(data,"kinds")) {
            let kind=nonempty(field(row,"type"))?;
            let table=field(row,"table")==Some(&Value::Bool(true));
            // recordModel validates participation shape even though this
            // owner only checks values; malformed DATA must not be admitted.
            for part in array(field(row,"parts")) {nonempty(field(part,"role"))?;if path(field(part,"path"))?.is_empty(){return Err(crate::cause!(Error::InvalidModel))}}
            out.shipped.insert(kind.clone(),Kind{properties:properties(field(row,"properties"))?});
            if let Some(Value::Array(fields))=field(row,"erasable") {
                if !fields.is_empty() {
                    if table{return Err(crate::cause!(Error::InvalidModel))}
                    let paths=fields.iter().map(field_path).collect::<Result<Vec<_>>>()?;
                    if paths.iter().any(Vec::is_empty){return Err(crate::cause!(Error::InvalidModel))}
                    out.erasable.insert(kind.clone(),paths);
                }
            }
            if let Some(key)=field(row,"erasable_key").filter(|v|truthy(v)){out.key_paths.insert(kind,field_path(key)?);}
        }
        for row in array(field(data,"declared_by")) {
            let kind=nonempty(field(row,"type"))?;
            let named=field(row,"kind").ok_or(crate::cause!(Error::InvalidModel))?;
            let props=field(row,"properties").ok_or(crate::cause!(Error::InvalidModel))?;
            let indexes=field(row,"indexes").and_then(|v|field(v,"path")).map(|v|path(Some(v))).transpose()?;
            if !out.rules.contains_key(&kind){out.rule_order.push(kind.clone());}
            out.rules.insert(kind,Rule{named:path(field(named,"path"))?,prefix:text(field(named,"prefix")).cloned().unwrap_or_default(),fields:path(field(props,"path"))?,name:path(field(props,"name"))?,kind:path(field(props,"kind"))?,choices:field(props,"choices").map(|v|path(Some(v))).transpose()?,moves:field(props,"moves").map(|v|path(Some(v))).transpose()?,kinds:entries(field(row,"kind_values")).into_iter().map(|(k,v)|(k.clone(),v.clone())).collect(),indexes});
        }
        Ok(out)
    }
    /// Exact RECORD_MODEL composition: list field kinds supply kind_values.
    /// The model alone omits this dependency: the list rule's field kinds (`field_kinds`), which the installed
    /// tools' joined model also holds.
    pub fn from_product_data(data:&Value,lists:&Value)->Result<Self> {
        let mut out=Self::from_data(data)?;
        let mut mapping=BTreeMap::new();
        for row in array(field(lists,"field_kinds")) {
            let id=nonempty(field(row,"id"))?;
            let value=field(row,"value").ok_or(crate::cause!(Error::InvalidModel))?.clone();
            mapping.insert(id,value);
        }
        for rule in out.rules.values_mut(){rule.kinds=mapping.clone();}
        Ok(out)
    }
    pub fn declares(&self,kind:&JsString)->bool {self.rules.contains_key(kind)}
    pub fn declaring_types(&self)->impl Iterator<Item=&JsString> {self.rule_order.iter()}
    pub fn declared_prefixes(&self)->impl Iterator<Item=&JsString> {self.rule_order.iter().filter_map(|kind|self.rules.get(kind).map(|rule|&rule.prefix))}
    pub fn erasable_fields(&self,kind:&JsString)->&[Vec<JsString>] {self.erasable.get(kind).map(Vec::as_slice).unwrap_or(&[])}
    /// Use the PROPOSED logical value. A new record's inherited owner cannot
    /// be inferred from a missing or previous stored row.
    pub fn key_owner(&self,kind:&JsString,id:&JsString,proposed:&Value)->JsString {
        self.key_paths.get(kind).and_then(|p|text(at(proposed,p))).filter(|s|!s.is_empty()).cloned().unwrap_or_else(||id.clone())
    }
    pub fn forget(&mut self,id:&JsString) {
        if let Some(old)=self.by_record.remove(id){if self.by_type.get(&old.kind)==Some(id){self.by_type.remove(&old.kind);}}
    }
    /// Load current declarations in the original owner's winner order.
    /// Forgetting a winner does not resurrect a previous losing declaration.
    pub fn declare(&mut self,kind:&JsString,id:&JsString,value:&Value)->Result<Option<JsString>> {
        self.forget(id);
        let Some(rule)=self.rules.get(kind) else{return Ok(None)};
        if !matches!(value,Value::Object(_)){return Ok(None)}
        let Some(named)=text(at(value,&rule.named)).filter(|s|!s.is_empty()) else{return Ok(None)};
        let named=JsString::from_units(rule.prefix.units().iter().chain(named.units()).copied().collect());
        let mut props=BTreeMap::new();let mut choices=BTreeMap::new();let mut moves=BTreeMap::new();let mut marks=BTreeMap::new();
        for field_value in array(at(value,&rule.fields)) {
            let Some(name)=text(at(field_value,&rule.name)).filter(|s|!s.is_empty()) else{continue};
            // The person-present mark binds a named field whatever its kind (`marks_declared` reads it the same way).
            let marked=marked_values(field_value);
            if !marked.is_empty()&&!ascii(name,"__proto__"){marks.insert(name.clone(),marked);}
            let given=at(field_value,&rule.kind);
            let mapped=given.and_then(|g|rule.kinds.get(&js_key(g))).filter(|v|!matches!(v,Value::Null)).or(given);
            let Some(mapped)=text(mapped) else{continue};
            // Assignment to Object.prototype's __proto__ setter with this
            // primitive string creates no own declared property in JS.
            if !ascii(name,"__proto__"){
                props.insert(name.clone(),mapped.clone());
                // A field that declares choices (a non-empty list of text) takes only those values.
                if let Some(Value::Array(given))=rule.choices.as_ref().and_then(|path|at(field_value,path)) {
                    let allowed:Vec<JsString>=given.iter().filter_map(|c|text(Some(c)).cloned()).collect();
                    if !allowed.is_empty(){choices.insert(name.clone(),allowed);}
                }
                // A field that declares moves (an object of from-value to the values it may change to) changes only by them.
                let given=entries(rule.moves.as_ref().and_then(|path|at(field_value,path)));
                if !given.is_empty() {
                    let declared:Moves=given.into_iter().map(|(from,to)|(from.clone(),array(Some(to)).iter().filter_map(|v|text(Some(v)).cloned()).collect())).collect();
                    moves.insert(name.clone(),declared);
                }
            }
        }
        if let Some(path)=&rule.indexes {validate_indexes(at(value,path),&props)?;}
        self.by_record.insert(id.clone(),Declaration{kind:named.clone(),properties:props,choices,moves,marks});
        self.by_type.insert(named.clone(),id.clone());Ok(Some(named))
    }
    /// Live writes keep undeclared properties and unknown kinds. Only a
    /// declared property's changed value is checked. Declared moves also check field release, including omission.
    /// A changed value is checked against its kind, then its declared choices, then its declared moves (`Moves`),
    /// from the value `before` holds when it is a row of the same kind (otherwise the field held no value).
    pub fn check_write(&self,kind:&JsString,desired:&Value,before:Option<(&JsString,&Value)>)->Result<Option<Refusal>> {
        let Value::Object(desired)=desired else{return Ok(None)};
        // A new kind cannot discard the old kind's controlled fields without their declared release move.
        if let Some((old_kind,old_value))=before.filter(|(old_kind,_)|*old_kind!=kind) {
            if let Some(refusal)=self.check_released_moves(old_kind,old_value,None){return Ok(Some(refusal))}
        }
        let declared=self.by_type.get(kind).and_then(|id|self.by_record.get(id));
        let mut props=declared.map(|d|d.properties.clone()).unwrap_or_default();
        if let Some(base)=self.shipped.get(kind){props.extend(base.properties.clone());}
        for (name,value) in desired.property_entries() {
            let Some(expected)=props.get(name) else{continue};
            let held=before.filter(|(before_kind,_)|*before_kind==kind).and_then(|(_,before_value)|member(before_value,name));
            if let Some(old)=held {if same_json(old,value)?{continue}}
            if !fits_kind(self.value_kinds.get(expected),value){return Ok(Some(Refusal{cause:crate::cause!(),kind:kind.clone(),property:name.clone(),expected:expected.clone(),outside:None,from:None}))}
            if let Some(outside)=declared.and_then(|d|d.choices.get(name)).and_then(|allowed|outside_choices(allowed,value)){
                return Ok(Some(Refusal{cause:crate::cause!(),kind:kind.clone(),property:name.clone(),expected:expected.clone(),outside:Some(outside),from:None}))
            }
            if let Some(from)=declared.and_then(|d|d.moves.get(name)).and_then(|moves|move_not_declared(moves,held,Some(value))){
                return Ok(Some(Refusal{cause:crate::cause!(),kind:kind.clone(),property:name.clone(),expected:expected.clone(),outside:Some(if matches!(value,Value::Null){START_OF_MOVES.into()}else{js_key(value)}),from:Some(from)}))
            }
        }
        if let Some((_,old_value))=before.filter(|(old_kind,_)|*old_kind==kind) {
            if let Some(refusal)=self.check_released_moves(kind,old_value,Some(desired)){return Ok(Some(refusal))}
        }
        Ok(None)
    }
    /// Only missing fields are checked here; fields still supplied were checked above in their original order.
    fn check_released_moves(&self,kind:&JsString,before:&Value,desired:Option<&ecma_json::Object>)->Option<Refusal> {
        let declared=self.by_type.get(kind).and_then(|id|self.by_record.get(id))?;
        for (name,moves) in &declared.moves {
            if desired.is_some_and(|desired|desired.get(name).is_some()){continue}
            if let Some(from)=move_not_declared(moves,member(before,name),None) {
                return Some(Refusal{cause:crate::cause!(),kind:kind.clone(),property:name.clone(),expected:declared.properties.get(name)?.clone(),outside:Some(START_OF_MOVES.into()),from:Some(from)})
            }
        }
        None
    }
    /// Every (row kind, field, value) that the declaring record `value` of `kind` would mark, read the way `declare`
    /// reads it: the declared row kind, each named field, and the text values of its `PERSON_PRESENT_MARK`. A record
    /// of a kind that declares nothing, or that names no row kind, marks nothing. Nothing is changed in the model.
    pub fn marks_declared(&self,kind:&JsString,value:&Value)->BTreeSet<Mark> {
        let mut out=BTreeSet::new();
        let Some(rule)=self.rules.get(kind) else{return out};
        if !matches!(value,Value::Object(_)){return out}
        let Some(named)=text(at(value,&rule.named)).filter(|s|!s.is_empty()) else{return out};
        let named=JsString::from_units(rule.prefix.units().iter().chain(named.units()).copied().collect());
        for field_value in array(at(value,&rule.fields)) {
            let Some(name)=text(at(field_value,&rule.name)).filter(|s|!s.is_empty()) else{continue};
            if ascii(name,"__proto__"){continue}
            for marked in marked_values(field_value) {out.insert((named.clone(),name.clone(),marked));}
        }
        out
    }
    /// The values each field of rows of `kind` may be set to only with the person present: the union over EVERY
    /// current declaration of that kind, not only the one whose field kinds win, so a second declaring record that
    /// omits the mark cannot shadow it.
    pub fn person_present_marks(&self,kind:&JsString)->BTreeMap<JsString,BTreeSet<JsString>> {
        let mut out=BTreeMap::<JsString,BTreeSet<JsString>>::new();
        for declaration in self.by_record.values().filter(|d|&d.kind==kind) {
            for (name,values) in &declaration.marks {out.entry(name.clone()).or_default().extend(values.iter().cloned());}
        }
        out
    }
    /// The fields of `value` whose value is outside the choices the declaration `id` gives them, as (field, value):
    /// what a list definition's change leaves behind in rows written under the old choices (`check_write` refuses a
    /// new such value; a row already holding one stays writable).
    pub fn outside_choices_of(&self,id:&JsString,value:&Value)->Vec<(JsString,JsString)> {
        let (Some(declared),Value::Object(object))=(self.by_record.get(id),value) else{return Vec::new()};
        declared.choices.iter().filter_map(|(name,allowed)|{
            let outside=outside_choices(allowed,object.get(name)?)?;
            Some((name.clone(),outside))
        }).collect()
    }
    /// The caller supplies canonical final logical state AFTER each effective
    /// envelope, in its actual order. Earlier no-op entries must be excluded or
    /// marked false; otherwise a losing declaration could become the winner.
    /// The original model stays unchanged if preflight/commit is refused.
    pub fn effective_for_final_writes<'a>(&self,writes:impl IntoIterator<Item=FinalWrite<'a>>)->Result<Self> {
        let mut out=self.clone();
        for write in writes {
            if !write.effective {continue}
            out.forget(write.id);
            if let (Some(kind),Some(value))=(write.kind,write.value) {
                if !matches!(value,Value::Null)&&out.declares(kind){out.declare(kind,write.id,value)?;}
            }
        }
        Ok(out)
    }
}
/// This describes the original envelope owner's already-derived final state.
/// It does not infer whole-record vs patch semantics from the submitted input.
pub struct FinalWrite<'a> {pub id:&'a JsString,pub kind:Option<&'a JsString>,pub value:Option<&'a Value>,pub effective:bool}
fn validate_indexes(value:Option<&Value>,properties:&BTreeMap<JsString,JsString>)->Result<()> {
    let Some(value)=value else{return Ok(())};let Value::Array(indexes)=value else{return Err(crate::cause!(Error::InvalidModel))};
    let mut names=BTreeSet::new();
    for index in indexes {
        let name=nonempty(field(index,"name"))?;if !names.insert(name){return Err(crate::cause!(Error::InvalidModel))}
        let Value::Array(fields)=field(index,"fields").ok_or(crate::cause!(Error::InvalidModel))? else{return Err(crate::cause!(Error::InvalidModel))};
        if fields.is_empty(){return Err(crate::cause!(Error::InvalidModel))}let mut seen=BTreeSet::new();
        for field in fields {let name=text(Some(field)).ok_or(crate::cause!(Error::InvalidModel))?;if !properties.contains_key(name)||!seen.insert(name){return Err(crate::cause!(Error::InvalidModel))}}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn json(raw:&str)->Value {ecma_json::parse(raw.as_bytes(),Default::default()).unwrap()}
    fn model()->Model {Model::from_data(&json(r#"{"value_kinds":{"text":{"is":"string"},"number":{"is":"number"},"ids":{"list_of":"id"}},"kinds":[{"type":"thing","properties":{"name":"text","n":"number"},"guard_properties":{"old":"text"}},{"type":"entry","erasable":["words",["input","said"]],"erasable_key":["donor"]}],"declared_by":[{"type":"schema","kind":{"path":["type"]},"properties":{"path":["fields"],"name":["name"],"kind":["kind"]},"indexes":{"path":["indexes"]}}]}"#)).unwrap()}
    #[test] fn live_model_is_open_and_does_not_apply_guard_properties() {let m=model();assert!(m.check_write(&"thing".into(),&json(r#"{"other":[1],"old":12}"#),None).unwrap().is_none());assert!(m.check_write(&"unregistered".into(),&json(r#"{"anything":12}"#),None).unwrap().is_none());}
    #[test] fn changed_property_is_checked_but_unchanged_legacy_bad_value_survives() {let m=model();let k="thing".into();let old=json(r#"{"name":12}"#);assert!(m.check_write(&k,&old,None).unwrap().is_some());assert!(m.check_write(&k,&old,Some((&k,&old))).unwrap().is_none());assert!(m.check_write(&k,&json(r#"{"name":13}"#),Some((&k,&old))).unwrap().is_some());assert!(m.check_write(&k,&json(r#"{"name":null}"#),None).unwrap().is_none());}
    #[test] fn base_property_definition_wins_over_user_declaration() {let mut m=model();m.declare(&"schema".into(),&"s1".into(),&json(r#"{"type":"thing","fields":[{"name":"name","kind":"number"}]}"#)).unwrap();assert!(m.check_write(&"thing".into(),&json(r#"{"name":"yes"}"#),None).unwrap().is_none());assert!(m.check_write(&"thing".into(),&json(r#"{"name":1}"#),None).unwrap().is_some());}
    #[test] fn winner_deletion_does_not_resurrect_previous_declaration() {let mut m=model();let ty="schema".into();let a="a".into();let b="b".into();m.declare(&ty,&a,&json(r#"{"type":"own","fields":[{"name":"x","kind":"text"}]}"#)).unwrap();m.declare(&ty,&b,&json(r#"{"type":"own","fields":[{"name":"x","kind":"number"}]}"#)).unwrap();m.forget(&a);assert!(m.check_write(&"own".into(),&json(r#"{"x":true}"#),None).unwrap().is_some());m.forget(&b);assert!(m.check_write(&"own".into(),&json(r#"{"x":true}"#),None).unwrap().is_none());}
    #[test] fn final_batch_model_validates_row_before_its_declaration() {let m=model();let id="s1".into();let ty="schema".into();let declaration=json(r#"{"type":"own","fields":[{"name":"x","kind":"number"}]}"#);let effective=m.effective_for_final_writes([FinalWrite{id:&id,kind:Some(&ty),value:Some(&declaration),effective:true}]).unwrap();assert!(effective.check_write(&"own".into(),&json(r#"{"x":"bad"}"#),None).unwrap().is_some());assert!(m.check_write(&"own".into(),&json(r#"{"x":"bad"}"#),None).unwrap().is_none());}
    #[test] fn noop_entry_does_not_promote_old_losing_declaration() {let mut m=model();let ty="schema".into();let a="a".into();let b="b".into();let first=json(r#"{"type":"own","fields":[{"name":"x","kind":"text"}]}"#);m.declare(&ty,&a,&first).unwrap();m.declare(&ty,&b,&json(r#"{"type":"own","fields":[{"name":"x","kind":"number"}]}"#)).unwrap();let effective=m.effective_for_final_writes([FinalWrite{id:&a,kind:Some(&ty),value:Some(&first),effective:false}]).unwrap();assert!(effective.check_write(&"own".into(),&json(r#"{"x":"bad"}"#),None).unwrap().is_some());}
    #[test] fn proposed_value_selects_exact_erasable_owner_and_paths() {let m=model();let kind="entry".into();let id="new".into();assert_eq!(m.key_owner(&kind,&id,&json(r#"{"donor":"original"}"#)),"original".into());assert_eq!(m.key_owner(&kind,&id,&json(r#"{"donor":""}"#)),id);assert_eq!(m.erasable_fields(&kind),&[vec!["words".into()],vec!["input".into(),"said".into()]]);}
    #[test] fn malformed_declared_index_refuses() {let mut m=model();assert_eq!(m.declare(&"schema".into(),&"s1".into(),&json(r#"{"type":"own","fields":[{"name":"x","kind":"text"}],"indexes":[{"name":"bad","fields":["missing"]}]}"#)),Err(crate::cause!(Error::InvalidModel)));}
    #[test] fn product_list_mapping_is_required_and_uses_exact_data_join() {let raw=json(r#"{"value_kinds":{"text":{"is":"string"}},"declared_by":[{"type":"schema","kind":{"path":["type"]},"properties":{"path":["fields"],"name":["name"],"kind":["kind"]}}]}"#);let lists=json(r#"{"field_kinds":[{"id":"long-text","value":"text"}]}"#);let mut m=Model::from_product_data(&raw,&lists).unwrap();m.declare(&"schema".into(),&"s1".into(),&json(r#"{"type":"own","fields":[{"name":"x","kind":"long-text"}]}"#)).unwrap();assert!(m.check_write(&"own".into(),&json(r#"{"x":12}"#),None).unwrap().is_some());}
    #[test] fn list_ids_keep_original_id_checks() {let raw=json(r#"{"value_kinds":{"ids":{"list_of":"id"}},"kinds":[{"type":"own","properties":{"x":"ids"}}]}"#);let m=Model::from_data(&raw).unwrap();assert!(m.check_write(&"own".into(),&json(r#"{"x":["ok","bad/path"]}"#),None).unwrap().is_some());assert!(m.check_write(&"own".into(),&json(r#"{"x":["ok","other"]}"#),None).unwrap().is_none());}
    #[test] fn a_field_that_declares_choices_refuses_a_changed_value_outside_them_and_names_it() {
        let raw=json(r#"{"value_kinds":{"text":{"is":"string"}},"declared_by":[{"type":"schema","kind":{"path":["type"]},"properties":{"path":["fields"],"name":["name"],"kind":["kind"],"choices":["choices"]}}]}"#);
        let lists=json(r#"{"field_kinds":[{"id":"choice","value":"text"},{"id":"tags","value":"text"}]}"#);
        let mut m=Model::from_product_data(&raw,&lists).unwrap();
        m.declare(&"schema".into(),&"s1".into(),&json(r#"{"type":"own","fields":[{"name":"state","kind":"choice","choices":["open","done"]},{"name":"free","kind":"choice"}]}"#)).unwrap();
        let own=JsString::from("own");
        let check=|value:&str,before:Option<&str>|{let before=before.map(json);m.check_write(&own,&json(value),before.as_ref().map(|v|(&own,v))).unwrap()};
        assert!(check(r#"{"state":"open"}"#,None).is_none());
        let refused=check(r#"{"state":"later"}"#,None).unwrap();
        assert_eq!((refused.property,refused.outside),(JsString::from("state"),Some(JsString::from("later"))));
        // A number is not text (its kind refuses it); null releases a value; a field without choices takes anything.
        assert!(check(r#"{"state":7}"#,None).is_some(),"a number is refused by its kind before its choices");
        assert!(check(r#"{"state":null}"#,None).is_none());
        assert!(check(r#"{"free":"anything"}"#,None).is_none());
        // A value a row already holds outside the choices is not refused while it is left as it is.
        assert!(check(r#"{"state":"legacy","other":1}"#,Some(r#"{"state":"legacy"}"#)).is_none());
        assert!(check(r#"{"state":"other-legacy"}"#,Some(r#"{"state":"legacy"}"#)).is_some());
    }
    /// A list whose `state` field declares moves (with a start) and choices, a `stage` field with moves but no start,
    /// and a `free` field with neither.
    fn moves_model()->Model {
        let raw=json(r#"{"value_kinds":{"text":{"is":"string"}},"declared_by":[{"type":"schema","kind":{"path":["type"]},"properties":{"path":["fields"],"name":["name"],"kind":["kind"],"choices":["choices"],"moves":["moves"]}}]}"#);
        let lists=json(r#"{"field_kinds":[{"id":"choice","value":"text"}]}"#);
        let mut m=Model::from_product_data(&raw,&lists).unwrap();
        m.declare(&"schema".into(),&"s1".into(),&json(r#"{"type":"own","fields":[
            {"name":"state","kind":"choice","choices":["waiting","taken","done","failed","withdrawn"],
             "moves":{"":["waiting"],"waiting":["taken","withdrawn"],"taken":["done","failed","waiting"],"done":[],"failed":[],"withdrawn":[]}},
            {"name":"stage","kind":"choice","moves":{"draft":["review"],"review":[""]}},
            {"name":"free","kind":"choice"}]}"#)).unwrap();
        m
    }
    fn check_moves(m:&Model,value:&str,before:Option<&str>)->Option<Refusal> {
        let own=JsString::from("own");let before=before.map(json);
        m.check_write(&own,&json(value),before.as_ref().map(|v|(&own,v))).unwrap()
    }
    #[test] fn a_declared_move_is_admitted() {
        let m=moves_model();
        assert!(check_moves(&m,r#"{"state":"taken"}"#,Some(r#"{"state":"waiting"}"#)).is_none());
        assert!(check_moves(&m,r#"{"state":"waiting"}"#,Some(r#"{"state":"taken"}"#)).is_none(),"a move back is admitted when listed");
        assert!(check_moves(&m,r#"{"stage":"review"}"#,Some(r#"{"stage":"draft"}"#)).is_none());
    }
    #[test] fn a_move_the_field_does_not_declare_is_refused_naming_from_and_to() {
        let m=moves_model();
        let refused=check_moves(&m,r#"{"state":"done"}"#,Some(r#"{"state":"waiting"}"#)).unwrap();
        assert_eq!((refused.property,refused.from,refused.outside),(JsString::from("state"),Some(JsString::from("waiting")),Some(JsString::from("done"))));
        // A final value (an empty list) moves nowhere; a value inside the choices is still refused by the moves.
        let refused=check_moves(&m,r#"{"state":"taken"}"#,Some(r#"{"state":"done"}"#)).unwrap();
        assert_eq!((refused.from,refused.outside),(Some(JsString::from("done")),Some(JsString::from("taken"))));
        // A value outside the choices is refused by the choices first (no from).
        assert_eq!(check_moves(&m,r#"{"state":"later"}"#,Some(r#"{"state":"waiting"}"#)).unwrap().from,None);
        // A row of another kind is a row that held no value here: its start is checked.
        let other=JsString::from("other");let held=json(r#"{"state":"taken"}"#);
        let refused=m.check_write(&"own".into(),&json(r#"{"state":"done"}"#),Some((&other,&held))).unwrap().unwrap();
        assert_eq!(refused.from,Some(JsString::from(START_OF_MOVES)));
    }
    #[test] fn a_new_row_starts_only_in_a_declared_start_value() {
        let m=moves_model();
        assert!(check_moves(&m,r#"{"state":"waiting"}"#,None).is_none());
        let refused=check_moves(&m,r#"{"state":"taken"}"#,None).unwrap();
        assert_eq!((refused.from,refused.outside),(Some(JsString::from(START_OF_MOVES)),Some(JsString::from("taken"))));
        // A row that held the field as null, or without it, held no value: the start applies.
        assert!(check_moves(&m,r#"{"state":"done"}"#,Some(r#"{"state":null}"#)).is_some());
        assert!(check_moves(&m,r#"{"state":"done"}"#,Some(r#"{"free":"x"}"#)).is_some());
        // Moves without a start leave a new row's value open, and restrict only the values they name.
        assert!(check_moves(&m,r#"{"stage":"anything"}"#,None).is_none());
        assert!(check_moves(&m,r#"{"stage":"draft"}"#,Some(r#"{"stage":"anything"}"#)).is_none());
        assert!(check_moves(&m,r#"{"stage":"anything"}"#,Some(r#"{"stage":"draft"}"#)).is_some());
    }
    #[test] fn an_unchanged_value_passes_but_releasing_a_final_value_is_refused() {
        let m=moves_model();
        assert!(check_moves(&m,r#"{"state":"done","free":"edited"}"#,Some(r#"{"state":"done","free":"x"}"#)).is_none());
        for desired in [r#"{"state":null}"#,r#"{"free":"edited"}"#,r#"{}"#] {
            let refused=check_moves(&m,desired,Some(r#"{"state":"done"}"#)).unwrap();
            assert_eq!((refused.kind,refused.property,refused.from,refused.outside),("own".into(),"state".into(),Some("done".into()),Some("".into())));
        }
    }
    #[test] fn release_requires_the_declared_empty_value_move_and_unset_stays_unset() {
        let m=moves_model();
        for desired in [r#"{"stage":null}"#,r#"{}"#] {
            assert!(check_moves(&m,desired,Some(r#"{"stage":"draft"}"#)).is_some());
            assert!(check_moves(&m,desired,Some(r#"{"stage":"review"}"#)).is_none());
        }
        assert!(check_moves(&m,r#"{"state":null}"#,Some(r#"{}"#)).is_none());
        assert!(check_moves(&m,r#"{}"#,Some(r#"{"state":null}"#)).is_none());
        assert!(check_moves(&m,r#"{"free":null}"#,Some(r#"{"free":"value"}"#)).is_none());
        assert!(check_moves(&m,r#"{"stage":null}"#,Some(r#"{"stage":"legacy"}"#)).is_some(),"releasing a held value requires an explicit move even for a legacy value");
    }
    #[test] fn changing_kind_checks_the_old_kinds_release_moves() {
        let m=moves_model();let own="own".into();let other="other".into();let desired=json(r#"{"state":"done"}"#);
        let held=json(r#"{"state":"done"}"#);
        let refused=m.check_write(&other,&desired,Some((&own,&held))).unwrap().unwrap();
        assert_eq!((refused.kind,refused.property,refused.from,refused.outside),(own.clone(),"state".into(),Some("done".into()),Some("".into())));
        let released=json(r#"{"stage":"review"}"#);
        assert!(m.check_write(&other,&json(r#"{}"#),Some((&own,&released))).unwrap().is_none());
    }
    #[test] fn a_list_without_moves_checks_as_before() {
        let m=moves_model();
        assert!(check_moves(&m,r#"{"free":"b"}"#,Some(r#"{"free":"a"}"#)).is_none());
        assert!(check_moves(&m,r#"{"free":"a"}"#,None).is_none());
        // A rule whose DATA names no moves path reads no moves, even where a field writes them.
        let mut m=Model::from_product_data(&json(r#"{"value_kinds":{"text":{"is":"string"}},"declared_by":[{"type":"schema","kind":{"path":["type"]},"properties":{"path":["fields"],"name":["name"],"kind":["kind"],"choices":["choices"]}}]}"#),&json(r#"{"field_kinds":[{"id":"choice","value":"text"}]}"#)).unwrap();
        m.declare(&"schema".into(),&"s1".into(),&json(r#"{"type":"own","fields":[{"name":"state","kind":"choice","moves":{"":["waiting"]}}]}"#)).unwrap();
        assert!(check_moves(&m,r#"{"state":"taken"}"#,None).is_none());
    }
    #[test] fn rule_iteration_keeps_first_insertion_order_and_latest_duplicate_content() {let raw=json(r#"{"declared_by":[{"type":"z","kind":{"path":[],"prefix":"first:"},"properties":{"path":[],"name":[],"kind":[]}},{"type":"a","kind":{"path":[],"prefix":"second:"},"properties":{"path":[],"name":[],"kind":[]}},{"type":"z","kind":{"path":[],"prefix":"last:"},"properties":{"path":[],"name":[],"kind":[]}}]}"#);let m=Model::from_data(&raw).unwrap();assert_eq!(m.declaring_types().cloned().collect::<Vec<_>>(),vec!["z".into(),"a".into()]);assert_eq!(m.declared_prefixes().cloned().collect::<Vec<_>>(),vec!["last:".into(),"second:".into()]);}
}
