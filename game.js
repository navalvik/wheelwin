const canvas = document.getElementById("wheel");
const ctx = canvas.getContext("2d");

let sectors = [
"Player1",
"Player2",
"Player3",
"Player4",
"Player5"
];

let angle = 0;
let speed = 0;

function drawWheel(){

let arc = (2*Math.PI)/sectors.length;

for(let i=0;i<sectors.length;i++){

ctx.beginPath();

ctx.fillStyle = i%2 ? "#22c55e" : "#3b82f6";

ctx.moveTo(150,150);

ctx.arc(
150,
150,
150,
angle + i*arc,
angle + (i+1)*arc
);

ctx.fill();

ctx.fillStyle="white";

ctx.fillText(
sectors[i],
130,
30
);

}

}

function spin(){

speed=0.2;

let spinInterval=setInterval(()=>{

angle+=speed;

ctx.clearRect(0,0,300,300);

drawWheel();

speed*=0.99;

if(speed<0.002){

clearInterval(spinInterval);

}

},16);

}

drawWheel();

document.getElementById("spinBtn").onclick=spin;
