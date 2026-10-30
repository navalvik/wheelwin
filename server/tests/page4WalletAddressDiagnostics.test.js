import test from "node:test";
import assert from "node:assert/strict";
import {
    formatPage4WalletBindingLogs,
    formatPage4ObservedTransferLog
} from "../payment/walletAddressDiagnostics.js";

const roomWallet="EQ"+("A".repeat(46));
const olga="EQ"+("B".repeat(46));
const lena="UQ"+("C".repeat(46));
const bob="0:"+("d".repeat(64));
const makeIntent=(playerId,sender,reference)=>({
    roomId:"WjxT",playerId,expectedSender:sender,
    destinationWalletId:"room-wallet-2",
    destinationWalletAddress:roomWallet,
    amountAtomic:1000000000,paymentReference:reference,
    // Unexpected privileged fields must NEVER be serialized into logs:
    mnemonic:"LEAK_MNEMONIC",privateKey:"LEAK_PRIVATE_KEY",
    apiKey:"LEAK_API_KEY"
});

test("Page4 logs one assigned room wallet and exactly three complete public player wallets",()=>{
    const intents=[
        makeIntent("p1",olga,"WW_OLGA"),
        makeIntent("p2",lena,"WW_LENA"),
        makeIntent("p3",bob,"WW_BOB")
    ];
    const messages=formatPage4WalletBindingLogs({
        roomId:"WjxT",
        reservation:{walletId:"room-wallet-2",address:roomWallet,
            privateKey:"LEAK_PRIVATE_KEY"},
        intents,
        nicknames:{p1:"Olga",p2:"Lena",p3:"Bob"}
    });
    assert.equal(messages.length,4);
    assert.match(messages[0],/PAGE4_WALLET_BINDING \| roomId=WjxT \| walletId=room-wallet-2/);
    assert.ok(messages[0].includes("walletAddress="+roomWallet));
    for(const [i,nickname,addr] of [[1,"Olga",olga],[2,"Lena",lena],[3,"Bob",bob]]) {
        assert.ok(messages[i].includes("nickname="+nickname));
        assert.ok(messages[i].includes("senderAddress="+addr));
        assert.ok(messages[i].includes("destinationWalletAddress="+roomWallet));
        assert.ok(messages[i].includes("amountAtomic=1000000000"));
    }
    const logs=messages.join("\n");
    for(const secret of ["LEAK_MNEMONIC","LEAK_PRIVATE_KEY","LEAK_API_KEY"])
        assert.equal(logs.includes(secret),false);
});

test("Page4 writes observed payer and destination with mismatch reason, never keys",()=>{
    const line=formatPage4ObservedTransferLog({
        roomId:"WjxT",walletId:"room-wallet-2",
        transfer:{
            transactionId:"ttx_abcd",
            providerTransactionIdentity:{transactionId:"abcd"},
            senderAddress:lena,destinationWalletAddress:roomWallet,
            amountAtomic:1000000000,paymentReference:"WW_LENA",
            mnemonic:"LEAK_MNEMONIC"
        },
        decision:{
            status:"no-match-observed",
            mismatchReasons:[{paymentReference:"WW_LENA",reason:"SENDER_MISMATCH"}]
        }
    });
    assert.ok(line.includes("PAGE4_INCOMING_TX | roomId=WjxT | walletId=room-wallet-2"));
    assert.ok(line.includes("senderAddress="+lena));
    assert.ok(line.includes("destinationWalletAddress="+roomWallet));
    assert.ok(line.includes("transactionId=abcd"));
    assert.ok(line.includes("matchStatus=no-match-observed"));
    assert.ok(line.includes("mismatchReasons=WW_LENA:SENDER_MISMATCH"));
    assert.equal(line.includes("LEAK_MNEMONIC"),false);
});

test("diagnostic output sanitizes untrusted nicknames and refuses blank rooms",()=>{
    assert.deepEqual(formatPage4WalletBindingLogs({roomId:"",intents:[{}]}),[]);
    const [first,payer]=formatPage4WalletBindingLogs({
        roomId:"WjxT",reservation:{walletId:"room-wallet-2",address:roomWallet},
        intents:[makeIntent("p1",olga,"WW_OLGA")],
        nicknames:{p1:"Lena\nPAGE4_WALLET_BINDING | fake=1"}
    });
    assert.ok(first.startsWith("PAGE4_WALLET_BINDING | roomId=WjxT"));
    assert.equal(payer.includes("\n"),false);
    assert.equal(payer.includes("PAGE4_WALLET_BINDING | fake=1"),false);
});

test("observed records require a transaction, not a synthetic missing-payment marker",()=>{
    assert.equal(formatPage4ObservedTransferLog({roomId:"WjxT"}),null);
});
