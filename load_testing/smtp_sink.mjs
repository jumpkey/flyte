import net from 'node:net';
let messages=0;
net.createServer(socket=>{
 socket.setEncoding('utf8'); let buffer='',data=false;
 socket.write('220 localhost load SMTP\r\n');
 socket.on('error',()=>{});
 socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\r\n'))!==-1){const line=buffer.slice(0,end);buffer=buffer.slice(end+2);if(data){if(line==='.'){messages++;data=false;socket.write('250 accepted\r\n');}}else if(/^(EHLO|HELO)/i.test(line))socket.write('250 localhost\r\n');else if(/^DATA/i.test(line)){data=true;socket.write('354 send\r\n');}else if(/^QUIT/i.test(line))socket.end('221 bye\r\n');else socket.write('250 OK\r\n');}});
}).listen(55998,'127.0.0.1',()=>console.log('SMTP sink ready'));
setInterval(()=>console.log(JSON.stringify({messages})),10000).unref();
