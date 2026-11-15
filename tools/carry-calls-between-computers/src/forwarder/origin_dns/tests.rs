//! The DNS TXT resolver: the answers it believes, from a local server that answers over UDP and, when the UDP answer
//! was cut short, over TCP. Every name and address here is made up.
use super::*;
use std::{io::{Read, Write}, net::{TcpListener, UdpSocket}, thread, time::Instant};

const TYPE_TXT: u16 = 16;
const CLASS_IN: u16 = 1;
const NAME: &str = "_trillion-verify.www.shop.example";

/// What a local resolver does with a question.
#[derive(Clone, Copy)]
enum Answers {
    /// Answers the records over UDP and over TCP.
    Records,
    /// Cuts every UDP answer short (TC) and answers the records over TCP.
    CutOverUdp,
    /// Answers with another id than the question's.
    WrongId,
    /// Answers no such name.
    NoSuchName,
}

/// The end of the question section of `question` (a header and one question; any additional records come after).
fn question_end(question: &[u8]) -> usize {
    let mut at = 12;
    while question[at] != 0 {
        at += 1 + usize::from(question[at]);
    }
    at + 1 + 4
}

/// The answer to `question` under `how`, holding `records` as TXT records of the asked name, each record its
/// character-strings.
fn answer(question: &[u8], records: &[Vec<String>], how: Answers, over_udp: bool) -> Vec<u8> {
    let cut = over_udp && matches!(how, Answers::CutOverUdp);
    let flags: u16 = match how {
        Answers::NoSuchName => 0x8183,
        _ if cut => 0x8380,
        _ => 0x8180,
    };
    let records = if cut || matches!(how, Answers::NoSuchName) { &[][..] } else { records };
    let mut bytes = question[..question_end(question)].to_vec();
    bytes[2..4].copy_from_slice(&flags.to_be_bytes());
    bytes[6..8].copy_from_slice(&(records.len() as u16).to_be_bytes());
    bytes[10..12].copy_from_slice(&0u16.to_be_bytes());
    if matches!(how, Answers::WrongId) {
        bytes[0] ^= 0xff;
    }
    for strings in records {
        bytes.extend_from_slice(&[0xc0, 12]); // the asked name, by pointer
        bytes.extend_from_slice(&TYPE_TXT.to_be_bytes());
        bytes.extend_from_slice(&CLASS_IN.to_be_bytes());
        bytes.extend_from_slice(&300u32.to_be_bytes());
        let data: Vec<u8> = strings.iter().flat_map(|text| std::iter::once(text.len() as u8).chain(text.bytes())).collect();
        bytes.extend_from_slice(&(data.len() as u16).to_be_bytes());
        bytes.extend_from_slice(&data);
    }
    bytes
}

/// A local resolver answering `records` as `how` says, at one address over UDP and TCP.
fn local_resolver(records: Vec<Vec<String>>, how: Answers) -> SocketAddr {
    let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
    let address = udp.local_addr().unwrap();
    let tcp = TcpListener::bind(address).unwrap();
    let for_udp = records.clone();
    thread::spawn(move || {
        let mut question = [0u8; 512];
        while let Ok((read, from)) = udp.recv_from(&mut question) {
            let _ = udp.send_to(&answer(&question[..read], &for_udp, how, true), from);
        }
    });
    thread::spawn(move || {
        for mut stream in tcp.incoming().flatten() {
            let mut length = [0u8; 2];
            if stream.read_exact(&mut length).is_err() { continue }
            let mut question = vec![0u8; usize::from(u16::from_be_bytes(length))];
            if stream.read_exact(&mut question).is_err() { continue }
            let reply = answer(&question, &records, how, false);
            let _ = stream.write_all(&(reply.len() as u16).to_be_bytes());
            let _ = stream.write_all(&reply);
        }
    });
    address
}

fn proof() -> Vec<Vec<String>> {
    vec![vec!["trillion-account=".to_owned(), "a".repeat(64)]]
}

fn proof_text() -> String {
    format!("trillion-account={}", "a".repeat(64))
}

#[test]
fn a_local_resolver_answers_the_proof_over_udp_and_over_tcp_when_cut_short() {
    let udp = DnsTxt::new(vec![local_resolver(proof(), Answers::Records)]).unwrap();
    assert_eq!(udp.txt(NAME), [proof_text()], "a record's character-strings are joined");
    let tcp = DnsTxt::new(vec![local_resolver(proof(), Answers::CutOverUdp)]).unwrap();
    assert_eq!(tcp.txt(&format!("{NAME}.")), [proof_text()], "a cut UDP answer is asked again over TCP");
    let two = DnsTxt::new(vec![local_resolver(vec![vec!["one".into()], vec!["v=spf1 -all".into()]], Answers::Records)]).unwrap();
    assert_eq!(two.txt(NAME), ["one", "v=spf1 -all"]);
}

#[test]
fn an_answer_that_is_not_ours_or_names_nothing_is_no_strings() {
    let mut wrong = DnsTxt::new(vec![local_resolver(proof(), Answers::WrongId)]).unwrap();
    wrong.wait = Duration::from_millis(600);
    assert!(wrong.txt(NAME).is_empty(), "another id is not an answer");
    let none = DnsTxt::new(vec![local_resolver(proof(), Answers::NoSuchName)]).unwrap();
    assert!(none.txt(NAME).is_empty(), "no such name: no strings");
    let ours = DnsTxt::new(vec![local_resolver(proof(), Answers::Records)]).unwrap();
    assert!(ours.txt("a..b").is_empty(), "an empty label is no name");
    assert!(ours.txt(&format!("{}.example", "a".repeat(64))).is_empty(), "a label is at most 63 bytes");
}

#[test]
fn a_resolver_that_never_answers_is_passed_over_for_the_next_one() {
    let silent = UdpSocket::bind("127.0.0.1:0").unwrap();
    let mut quick = DnsTxt::new(vec![silent.local_addr().unwrap(), local_resolver(vec![vec!["x".into()]], Answers::Records)]).unwrap();
    quick.wait = Duration::from_millis(1500);
    let started = Instant::now();
    assert_eq!(quick.txt(NAME), ["x"], "the silent one took only its share of the wait");
    assert!(started.elapsed() < Duration::from_secs(3));
    drop(silent);
}

#[test]
fn the_forwarder_believes_a_domain_by_the_production_resolver() {
    use crate::forwarder::origins::{Origin, OriginBook, OriginsRow};
    let owner = crate::account::computers::AccountKey::from_secret_text(&"07".repeat(32)).unwrap();
    let resolver = DnsTxt::new(vec![local_resolver(vec![vec![format!("trillion-account={}", owner.address())]], Answers::Records)]).unwrap();
    let row = OriginsRow::sign(1, &[Origin { host: "www.shop.example".into(), installation: "a".repeat(32), moved_to: None }], &owner).unwrap();
    let book = OriginBook::new();
    book.take(&owner.address(), row, 1, &|_| true, Some(&resolver)).unwrap();
    assert!(book.may_certify("www.shop.example", &|_| true));
}
