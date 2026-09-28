const path=require("path");
const http=require("http");
const express=require("express");
const {Server}=require("socket.io");
const app=express(), server=http.createServer(app), io=new Server(server);
const PORT=process.env.PORT||3000;
app.use(express.static(path.join(__dirname,"public")));
const rooms=new Map();
const COLORS=["#ef4444","#3b82f6","#22c55e","#f59e0b"];

const boardNames=[
"СТАРТ","Коричневая 1","Общественная казна","Коричневая 2","Налог","Ж/Д Восток",
"Голубая 1","Шанс","Голубая 2","Голубая 3","Тюрьма / Гость","Розовая 1",
"Электрокомпания","Розовая 2","Розовая 3","Ж/Д Север","Оранжевая 1","Общественная казна",
"Оранжевая 2","Оранжевая 3","Бесплатная стоянка","Красная 1","Шанс","Красная 2","Красная 3",
"Ж/Д Запад","Жёлтая 1","Жёлтая 2","Водоканал","Жёлтая 3","В ТЮРЬМЕ","Зелёная 1",
"Зелёная 2","Общественная казна","Зелёная 3","Ж/Д Юг","Тёмно-синяя 1","Шанс",
"Тёмно-синяя 2","Тёмно-синяя 3","На посещении","Шанс","Финальная 1","Финальная 2"
];
const propertyIds=new Set([1,3,6,8,9,11,13,14,16,18,19,21,23,24,26,27,29,31,32,34,36,38,39,42,43]);
const railIds=new Set([5,15,25,35]), chanceIds=new Set([7,22,37,41]), chestIds=new Set([2,17,33]);
const taxMap={4:100,28:150};
const prices=[60,60,100,100,120,140,140,160,180,180,200,220,220,240,260,260,280,300,300,320,350,350,400,400,450,450];

function makeBoard(){
 let pi=0; return boardNames.map((name,id)=>{
  const c={id,name,type:"special",owner:null,houses:0,price:0,mortgaged:false};
  if(propertyIds.has(id)){c.type="property";c.price=prices[pi++];c.group=groupOf(id);}
  else if(railIds.has(id)){c.type="railroad";c.price=200;}
  else if(chanceIds.has(id)){c.type="chance";}
  else if(chestIds.has(id)){c.type="chest";}
  else if(taxMap[id]){c.type="tax";c.price=taxMap[id];}
  else if(id===10||id===30||id===40){c.type="jail";}
  else if(id===20){c.type="free";}
  return c;
 });
}
function groupOf(id){
 if([1,3].includes(id))return"brown"; if([6,8,9].includes(id))return"blue";
 if([11,13,14].includes(id))return"pink"; if([16,18,19].includes(id))return"orange";
 if([21,23,24].includes(id))return"red"; if([26,27,29].includes(id))return"yellow";
 if([31,32,34].includes(id))return"green"; if([36,38,39].includes(id))return"darkblue";
 return"other";
}
function newGame(maxPlayers){
 return {maxPlayers,players:[],board:makeBoard(),turn:0,started:false,winner:null,lastRoll:[1,1],
 message:"Создайте комнату и пригласите друзей.",pending:null,auction:null,trade:null,
 doubles:0, logs:[]};
}
function code(){
 const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let s;
 do{s=Array.from({length:6},()=>chars[Math.floor(Math.random()*chars.length)]).join("")}while(rooms.has(s));
 return s;
}
function log(g,t){g.logs.unshift(t);g.logs=g.logs.slice(0,30);}
function pub(r){
 const g=r.game;
 return {code:r.code,host:r.host,maxPlayers:g.maxPlayers,started:g.started,turn:g.turn,winner:g.winner,
 lastRoll:g.lastRoll,message:g.message,logs:g.logs,board:g.board,auction:g.auction,trade:g.trade,
 pending:g.pending,players:g.players.map(p=>({id:p.id,name:p.name,color:p.color,money:p.money,pos:p.pos,
 bankrupt:p.bankrupt,inJail:p.inJail,jailTurns:p.jailTurns,connected:p.connected}))};
}
function broadcast(r){io.to(r.code).emit("state",pub(r));}
function current(r){return r.game.players[r.game.turn];}
function alive(g){return g.players.filter(p=>!p.bankrupt);}
function nextTurn(r){
 const g=r.game;
 for(let n=1;n<=g.players.length;n++){
  const i=(g.turn+n)%g.players.length,p=g.players[i];
  if(p&&!p.bankrupt){g.turn=i;g.doubles=0;return;}
 }
}
function playerBy(r,id){return r.game.players.find(p=>p.id===id);}
function rent(cell,g){
 if(cell.type==="railroad"){
  const count=g.board.filter(x=>x.type==="railroad"&&x.owner===cell.owner).length;
  return 25*Math.pow(2,Math.max(0,count-1));
 }
 let base=Math.max(10,Math.round(cell.price*.12));
 if(cell.houses===0)return base;
 return base* (cell.houses===1?5:cell.houses===2?15:cell.houses===3?45:80);
}
function canBuild(r,p,c){
 if(c.type!=="property"||c.owner!==p.id||c.mortgaged||c.houses>=5)return false;
 const same=r.game.board.filter(x=>x.group===c.group&&x.type==="property");
 return same.every(x=>x.owner===p.id&&!x.mortgaged);
}
function move(r,p,steps){
 const old=p.pos;p.pos=(p.pos+steps)%44;
 if(p.pos<old){p.money+=200;log(r.game,`${p.name} прошёл СТАРТ и получил $200.`);}
 land(r,p);
}
function bankrupt(r,p){
 p.bankrupt=true;p.money=0;
 r.game.board.forEach(c=>{if(c.owner===p.id){c.owner=null;c.houses=0;c.mortgaged=false;}});
 if(alive(r.game).length<=1){const w=alive(r.game)[0];r.game.winner=w?.id||null;r.game.started=false;r.game.pending=null;r.game.auction=null;r.game.trade=null;
  r.game.message=w?`${w.name} победил!`:"Игра окончена.";log(r.game,r.game.message);}
}
function pay(r,p,to,amount){
 p.money-=amount;if(to)to.money+=amount;
 if(p.money<0)bankrupt(r,p);
}
function card(r,p,type){
 const cards=[
  ["Бонус: банк выплатил $150.",150],["Ремонт: заплати $100.",-100],["Премия за сделку: +$100.",100],
  ["Штраф: -$50.",-50],["Подарок: +$200.",200]
 ];
 const c=cards[Math.floor(Math.random()*cards.length)];p.money+=c[1];r.game.message=c[0];
 if(p.money<0)bankrupt(r,p);
}
function land(r,p){
 const g=r.game,c=g.board[p.pos];let msg=`${p.name}: «${c.name}».`;
 if(c.type==="property"||c.type==="railroad"){
  if(c.owner===null){g.pending={type:"buy",playerId:p.id,cellId:c.id};msg+=` Можно купить за $${c.price} или отправить на аукцион.`;}
  else if(c.owner!==p.id&&!c.mortgaged){const o=playerBy(r,c.owner);const rr=rent(c,g);pay(r,p,o,rr);msg+=` Аренда $${rr}.`;}
 } else if(c.type==="tax"){pay(r,p,null,c.price);msg+=` Налог $${c.price}.`;}
 else if(c.type==="chance"||c.type==="chest"){card(r,p,c.type);msg+=" "+g.message;}
 else if(p.pos===30){p.pos=10;p.inJail=true;p.jailTurns=0;msg+=" Отправлен в тюрьму.";}
 g.message=msg;log(g,msg);
}
function endIfNeeded(r){
 const g=r.game;if(g.winner)return;
 if(alive(g).length<=1){const w=alive(g)[0];g.winner=w?.id||null;g.started=false;g.message=w?`${w.name} победил!`:"Игра окончена.";}
}
function startAuction(r,cellId,initiator){
 const g=r.game;g.pending=null;g.auction={cellId,currentBid:0,highest:null,turnIndex:g.players.findIndex(p=>p.id===initiator),passed:[]};
 g.message=`Аукцион: ${g.board[cellId].name}. Начальная ставка $0.`;
}
function nextAuction(r){
 const a=r.game.auction,g=r.game;
 for(let n=1;n<=g.players.length;n++){
  const i=(a.turnIndex+n)%g.players.length,p=g.players[i];
  if(p&&!p.bankrupt&&!a.passed.includes(p.id)){a.turnIndex=i;return;}
 }
 finishAuction(r);
}
function finishAuction(r){
 const g=r.game,a=g.auction;if(!a)return;
 const c=g.board[a.cellId];
 if(a.highest){
  const p=playerBy(r,a.highest); if(p&&p.money>=a.currentBid){p.money-=a.currentBid;c.owner=p.id;g.message=`${p.name} выиграл аукцион за $${a.currentBid}.`;log(g,g.message);}
 } else {g.message="Аукцион завершён без победителя.";}
 g.auction=null;
}
function nextRoomTurn(r){nextTurn(r);r.game.message=`Ход игрока ${current(r)?.name||"—"}.`;broadcast(r);}

io.on("connection",s=>{
 s.on("createRoom",({name,maxPlayers})=>{
  name=String(name||"Игрок").trim().slice(0,18);const code=code(),r={code,host:s.id,game:newGame(Math.max(2,Math.min(4,+maxPlayers||4)))};
  rooms.set(code,r);s.data.room=code;s.join(code);r.game.players.push({id:s.id,name,color:COLORS[0],money:1500,pos:0,bankrupt:false,inJail:false,jailTurns:0,connected:true});
  s.emit("joined",{code,host:true});broadcast(r);
 });
 s.on("joinRoom",({code,name})=>{
  code=String(code||"").trim().toUpperCase();const r=rooms.get(code);name=String(name||"Игрок").trim().slice(0,18);
  if(!r)return s.emit("errorMsg","Комната не найдена.");
  if(r.game.started)return s.emit("errorMsg","Игра уже началась.");
  if(r.game.players.length>=r.game.maxPlayers)return s.emit("errorMsg","Комната заполнена.");
  if(r.game.players.some(p=>p.name.toLowerCase()===name.toLowerCase()))return s.emit("errorMsg","Такое имя уже занято.");
  s.data.room=code;s.join(code);r.game.players.push({id:s.id,name,color:COLORS[r.game.players.length%4],money:1500,pos:0,bankrupt:false,inJail:false,jailTurns:0,connected:true});
  s.emit("joined",{code,host:false});broadcast(r);
 });
 s.on("startGame",()=>{
  const r=rooms.get(s.data.room);if(!r||r.host!==s.id)return;
  if(r.game.players.length<2)return s.emit("errorMsg","Нужно минимум 2 игрока.");
  r.game.started=true;r.game.message=`Ход игрока ${current(r).name}.`;log(r.game,"Игра началась.");broadcast(r);
 });
 s.on("roll",()=>{
  const r=rooms.get(s.data.room);if(!r||!r.game.started||r.game.pending||r.game.auction||r.game.trade)return;
  const g=r.game,p=current(r);if(!p||p.id!==s.id||p.bankrupt)return;
  if(p.inJail){
   p.jailTurns++;
   const doubles=Math.random()<.25;
   if(doubles||p.jailTurns>=3){p.inJail=false;p.jailTurns=0;g.message=`${p.name} вышел из тюрьмы.`;}
   else {g.message=`${p.name} не выбросил дубль и остаётся в тюрьме.`;nextTurn(r);broadcast(r);return;}
  }
  const a=1+Math.floor(Math.random()*6),b=1+Math.floor(Math.random()*6);g.lastRoll=[a,b];
  if(a===b)g.doubles++;else g.doubles=0;
  if(g.doubles>=3){p.pos=10;p.inJail=true;g.doubles=0;g.message=`${p.name} выбросил три дубля и отправлен в тюрьму.`;nextTurn(r);}
  else {move(r,p,a+b);if(g.doubles===0&&!g.pending&&!g.auction&&!p.bankrupt)nextTurn(r);else if(g.doubles>0&&!g.pending&&!g.auction&&!p.bankrupt)g.message+=` Дубль! ${p.name} ходит ещё раз.`;}
  endIfNeeded(r);broadcast(r);
 });
 s.on("buy",()=>{
  const r=rooms.get(s.data.room);if(!r)return;const g=r.game,p=current(r);const c=p&&g.board[p.pos];
  if(!p||p.id!==s.id||!g.pending||g.pending.playerId!==p.id||g.pending.cellId!==c.id||p.money<c.price)return;
  c.owner=p.id;p.money-=c.price;g.pending=null;g.message=`${p.name} купил «${c.name}» за $${c.price}.`;log(g,g.message);if(g.doubles===0)nextTurn(r);broadcast(r);
 });
 s.on("auction",()=>{
  const r=rooms.get(s.data.room);if(!r)return;const g=r.game,p=current(r),c=p&&g.board[p.pos];
  if(!p||p.id!==s.id||!g.pending||g.pending.playerId!==p.id)return;
  startAuction(r,c.id,p.id);broadcast(r);
 });
 s.on("bid",({amount})=>{
  const r=rooms.get(s.data.room);if(!r||!r.game.auction)return;const g=r.game,a=g.auction,p=playerBy(r,s.id);
  const n=Math.floor(+amount);if(!p||p.bankrupt||a.passed.includes(p.id)||p.money<n||n<=a.currentBid)return;
  a.currentBid=n;a.highest=p.id;g.message=`${p.name} предложил $${n}.`;nextAuction(r);broadcast(r);
 });
 s.on("passAuction",()=>{
  const r=rooms.get(s.data.room);if(!r||!r.game.auction)return;const a=r.game.auction,p=playerBy(r,s.id);
  if(!p||a.passed.includes(p.id))return;a.passed.push(p.id);
  const eligible=r.game.players.filter(x=>!x.bankrupt&&!a.passed.includes(x.id));
  if(eligible.length<=1)finishAuction(r);else nextAuction(r);
  if(!r.game.auction&&r.game.doubles===0)nextTurn(r);broadcast(r);
 });
 s.on("build",()=>{
  const r=rooms.get(s.data.room);if(!r)return;const g=r.game,p=current(r),c=p&&g.board[p.pos];if(!p||p.id!==s.id||g.pending||g.auction)return;
  if(!canBuild(r,p,c))return;const cost=Math.max(50,Math.round(c.price*.5));if(p.money<cost)return;
  p.money-=cost;c.houses++;g.message=`${p.name} построил ${c.houses>=5?"отель":"дом"} на «${c.name}».`;log(g,g.message);broadcast(r);
 });
 s.on("sellHouse",()=>{
  const r=rooms.get(s.data.room);if(!r)return;const g=r.game,p=current(r),c=p&&g.board[p.pos];if(!p||p.id!==s.id||c?.owner!==p.id||c.houses<=0)return;
  c.houses--;p.money+=Math.round(c.price*.25);g.message=`${p.name} продал улучшение на «${c.name}».`;broadcast(r);
 });
 s.on("mortgage",()=>{
  const r=rooms.get(s.data.room);if(!r)return;const g=r.game,p=current(r),c=p&&g.board[p.pos];if(!p||p.id!==s.id||c?.owner!==p.id||c.houses>0||c.mortgaged)return;
  c.mortgaged=true;p.money+=Math.round(c.price*.5);g.message=`${p.name} заложил «${c.name}».`;broadcast(r);
 });
 s.on("unmortgage",()=>{
  const r=rooms.get(s.data.room);if(!r)return;const g=r.game,p=current(r),c=p&&g.board[p.pos];if(!p||p.id!==s.id||c?.owner!==p.id||!c.mortgaged)return;
  const cost=Math.round(c.price*.55);if(p.money<cost)return;c.mortgaged=false;p.money-=cost;g.message=`${p.name} выкупил «${c.name}».`;broadcast(r);
 });
 s.on("tradeOffer",({toId,offerMoney,requestMoney,offerCell,requestCell})=>{
  const r=rooms.get(s.data.room);if(!r)return;const g=r.game,from=playerBy(r,s.id),to=playerBy(r,toId);
  if(!from||!to||from.bankrupt||to.bankrupt||from.id===to.id||g.trade)return;
  const oc=offerCell==null?null:g.board[+offerCell],rc=requestCell==null?null:g.board[+requestCell];
  if(oc&&oc.owner!==from.id)return;if(rc&&rc.owner!==to.id)return;
  const om=Math.max(0,Math.floor(+offerMoney||0)),rm=Math.max(0,Math.floor(+requestMoney||0));
  if(from.money<om||to.money<rm)return;
  g.trade={fromId:from.id,toId:to.id,offerMoney:om,requestMoney:rm,offerCell:oc?.id??null,requestCell:rc?.id??null};
  g.message=`${from.name} предлагает обмен игроку ${to.name}.`;broadcast(r);
 });
 s.on("tradeAccept",()=>{
  const r=rooms.get(s.data.room),g=r?.game;if(!r||!g.trade||g.trade.toId!==s.id)return;const t=g.trade,from=playerBy(r,t.fromId),to=playerBy(r,t.toId);
  const oc=t.offerCell==null?null:g.board[t.offerCell],rc=t.requestCell==null?null:g.board[t.requestCell];
  if(!from||!to||from.money<t.offerMoney||to.money<t.requestMoney)return;
  if(oc&&oc.owner!==from.id||rc&&rc.owner!==to.id)return;
  from.money-=t.offerMoney;to.money-=t.requestMoney;from.money+=t.requestMoney;to.money+=t.offerMoney;
  if(oc)oc.owner=to.id;if(rc)rc.owner=from.id;
  g.message=`Обмен между ${from.name} и ${to.name} завершён.`;g.trade=null;log(g,g.message);broadcast(r);
 });
 s.on("tradeReject",()=>{const r=rooms.get(s.data.room);if(!r||!r.game.trade||r.game.trade.toId!==s.id)return;r.game.message="Предложение обмена отклонено.";r.game.trade=null;broadcast(r);});
 s.on("endTurn",()=>{
  const r=rooms.get(s.data.room);if(!r)return;const g=r.game,p=current(r);if(!p||p.id!==s.id||g.pending||g.auction||g.trade)return;
  if(g.doubles>0){g.message=`${p.name} бросил дубль — его ход продолжается.`;broadcast(r);return;}
  nextTurn(r);g.message=`Ход игрока ${current(r)?.name||"—"}.`;broadcast(r);
 });
 s.on("disconnect",()=>{
  const r=rooms.get(s.data.room);if(!r)return;const p=playerBy(r,s.id);
  if(p)p.connected=false;
  if(r.host===s.id){const n=r.game.players.find(x=>x.connected&&!x.bankrupt);if(n)r.host=n.id;}
  broadcast(r);
 });
});
server.listen(PORT,()=>console.log("Monopoly Online on "+PORT));
