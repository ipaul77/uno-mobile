const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = {};
const botAvatars = ['👨‍💼', '👩‍💼', '👨‍⚕️', '👩‍⚕️', '👨‍🎓', '👩‍🎓', '👨‍🍳', '👩‍🍳', '👨‍🎤', '👩‍🎤', '👨‍🏫', '👩‍🏫', '🕵️‍♂️', '🕵️‍♀️', '👨‍🚀'];

function initRoom(roomName) {
    return {
        name: roomName,
        players: [], deck: [], topCard: null, currentTurnIndex: 0,
        direction: 1, botCounter: 1, isGameRunning: false, penaltyStack: 0,
        turnLocked: false
    };
}

function broadcastRoomList() {
    const availableRooms = [];
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (!room.isGameRunning) { 
            const host = room.players.find(p => p.isHost);
            availableRooms.push({
                id: roomId,
                name: room.name,
                hostName: host ? host.name : '알 수 없음',
                playerCount: room.players.length
            });
        }
    }
    io.to('lobby').emit('roomList', availableRooms);
}

function createDeck() {
    const colors = ['red', 'goldenrod', 'green', 'royalblue'];
    const numbers = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const actionTypes = ['skip', 'reverse', 'draw2'];
    let newDeck = [];
    for (let color of colors) {
        for (let number of numbers) {
            newDeck.push({ color, value: number });
            if (number !== '0') newDeck.push({ color, value: number });
        }
        for (let action of actionTypes) {
            newDeck.push({ color, value: action });
            newDeck.push({ color, value: action });
        }
    }
    for (let i = 0; i < 4; i++) {
        newDeck.push({ color: 'black', value: 'wild' });
        newDeck.push({ color: 'black', value: 'wildDraw4' });
    }
    return newDeck;
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function broadcastGameState(roomId) {
    const room = rooms[roomId];
    if(!room || !room.isGameRunning || room.players.length === 0) return;
    
    room.players.forEach(player => {
        if (!player.isBot) {
            io.to(player.id).emit('updateGame', {
                topCard: room.topCard,
                direction: room.direction, 
                penaltyStack: room.penaltyStack,
                currentTurnId: room.players[room.currentTurnIndex] ? room.players[room.currentTurnIndex].id : null,
                myHand: player.hand,
                playersInfo: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, cardCount: p.hand.length, isHost: p.isHost }))
            });
        }
    });
}

function nextTurn(roomId, steps) {
    const room = rooms[roomId];
    if (!room || room.players.length === 0 || !room.isGameRunning) return;
    
    room.players.forEach(p => {
        // 💡 1. 누군가 우노를 외치지 않고 턴이 넘어갈 때의 봇의 자동 벌점 부여
        if (p.hand.length === 1 && !p.unoDeclared) {
            const botCatcher = room.players.find(b => b.isBot && b.id !== p.id);
            if (botCatcher) {
                if(room.deck.length > 0) p.hand.push(room.deck.pop());
                if(room.deck.length > 0) p.hand.push(room.deck.pop());
                p.unoDeclared = true;
                io.to(roomId).emit('systemMessage', `[시스템] ${botCatcher.name}가 ${p.name}의 우노를 적발했습니다. (+2장)`);
                // 💥 벌칙 이벤트 발생
                io.to(roomId).emit('penaltyApplied', { targetId: p.id, count: 2 });
            }
        }
    });

    room.currentTurnIndex = (room.currentTurnIndex + (room.direction * steps) + room.players.length * 10) % room.players.length;
    broadcastGameState(roomId);

    const currentPlayer = room.players[room.currentTurnIndex];
    if (currentPlayer && currentPlayer.isBot) {
        setTimeout(() => { playBotTurn(roomId, currentPlayer); }, 2200);
    }
}

function playBotTurn(roomId, botPlayer) {
    const room = rooms[roomId];
    if (!room || room.players.length === 0 || botPlayer.hand.length === 0 || !room.isGameRunning) return;

    let playableCardIndex = -1;

    if (room.penaltyStack > 0) {
        playableCardIndex = botPlayer.hand.findIndex(c => c.value === 'draw2' || c.value === 'wildDraw4');
    } else {
        for (let i = 0; i < botPlayer.hand.length; i++) {
            const card = botPlayer.hand[i];
            if (card.color === 'black' || card.color === room.topCard.color || card.value === room.topCard.value) {
                playableCardIndex = i; break;
            }
        }
    }

    if (playableCardIndex !== -1) {
        const playedCard = botPlayer.hand[playableCardIndex];
        let selectedColor = null;
        if (playedCard.color === 'black') {
            const colors = ['red', 'goldenrod', 'green', 'royalblue'];
            selectedColor = colors[Math.floor(Math.random() * colors.length)];
        }
        if (botPlayer.hand.length === 2) {
            botPlayer.unoDeclared = true;
            io.to(roomId).emit('systemMessage', `${botPlayer.name}: "우노!"`);
        }
        executePlayCard(roomId, botPlayer, playableCardIndex, selectedColor);
    } else {
        executeDrawCard(roomId, botPlayer);
    }
}

function executePlayCard(roomId, player, cardIndex, selectedColor) {
    const room = rooms[roomId];
    room.turnLocked = true; 

    const playedCard = player.hand[cardIndex];
    player.hand.splice(cardIndex, 1);

    const colorNames = { 'red': '빨강', 'goldenrod': '노랑', 'green': '초록', 'royalblue': '파랑' };
    if (playedCard.color === 'black') {
        room.topCard = { color: selectedColor, value: playedCard.value };
        io.to(roomId).emit('systemMessage', `바닥 색상이 [${colorNames[selectedColor]}] 색으로 변경되었습니다.`);
    } else {
        room.topCard = playedCard;
    }
    
    broadcastGameState(roomId);
    io.to(roomId).emit('actionSound', 'play');

    if (player.hand.length !== 1) player.unoDeclared = false;

    if (player.hand.length === 0) {
        room.isGameRunning = false;
        io.to(roomId).emit('gameOver', player.name);
        broadcastRoomList(); 
        return;
    }

    let steps = 1;
    if (playedCard.value === 'draw2') {
        room.penaltyStack += 2;
        io.to(roomId).emit('systemMessage', `💣 ${player.name}님이 +2 폭탄을 던졌습니다! (누적: ${room.penaltyStack}장)`);
    } else if (playedCard.value === 'wildDraw4') {
        room.penaltyStack += 4;
        io.to(roomId).emit('systemMessage', `💣 ${player.name}님이 +4 핵폭탄을 던졌습니다! (누적: ${room.penaltyStack}장)`);
    } else {
        if (playedCard.value === 'reverse') {
            room.direction *= -1;
            io.to(roomId).emit('systemMessage', `진행 방향이 역전되었습니다.`);
            if (room.players.length === 2) steps = 2; 
        } else if (playedCard.value === 'skip') {
            let nextIdx = (room.currentTurnIndex + room.direction + room.players.length * 10) % room.players.length;
            io.to(roomId).emit('systemMessage', `${room.players[nextIdx].name}의 턴이 건너뛰어집니다.`);
            steps = 2;
        }
    }

    setTimeout(() => {
        room.turnLocked = false;
        nextTurn(roomId, steps);
    }, 1200);
}

function executeDrawCard(roomId, player) {
    const room = rooms[roomId];
    room.turnLocked = true; 

    // 💡 2. 누적된 폭탄을 먹어야 하는 경우 (방어 실패)
    if (room.penaltyStack > 0) {
        let drawnCards = room.penaltyStack;
        for (let i = 0; i < room.penaltyStack; i++) {
            if (room.deck.length > 0) player.hand.push(room.deck.pop());
        }
        io.to(roomId).emit('systemMessage', `💥 앗! 방어 실패! ${player.name}님이 누적된 ${room.penaltyStack}장을 먹었습니다!`);
        room.penaltyStack = 0; 
        // 💥 벌칙 이벤트 발생
        io.to(roomId).emit('penaltyApplied', { targetId: player.id, count: drawnCards });
    } else {
        if (room.deck.length > 0) player.hand.push(room.deck.pop());
        io.to(roomId).emit('systemMessage', `${player.name}이(가) 카드를 뽑았습니다.`);
    }

    player.unoDeclared = false;
    broadcastGameState(roomId);
    io.to(roomId).emit('actionSound', 'draw');
    
    setTimeout(() => {
        room.turnLocked = false;
        nextTurn(roomId, 1);
    }, 1200);
}

io.on('connection', (socket) => {
    socket.join('lobby');
    broadcastRoomList();

    socket.on('createRoom', (data) => {
        const { nickname, avatar, roomName } = data;
        const roomId = 'room_' + Math.random().toString(36).substr(2, 6);
        
        rooms[roomId] = initRoom(roomName || `${nickname}의 테이블`);
        const room = rooms[roomId];

        socket.leave('lobby');
        socket.join(roomId);
        socket.roomId = roomId;

        room.players.push({ 
            id: socket.id, name: nickname, avatar: avatar, hand: [], 
            unoDeclared: false, isBot: false, isHost: true, isReady: true 
        });
        
        socket.emit('joinSuccess', { isHost: true, roomName: room.name });
        io.to(roomId).emit('updatePlayers', room.players);
        broadcastRoomList(); 
    });

    socket.on('joinRoom', (data) => {
        const { nickname, avatar, roomId } = data;
        const room = rooms[roomId];

        if (!room) return socket.emit('joinError', '존재하지 않는 방입니다.');
        if (room.isGameRunning) return socket.emit('joinError', '현재 게임이 진행 중인 방입니다.');
        if (room.players.some(p => p.name === nickname)) return socket.emit('joinError', '방에 이미 사용 중인 닉네임이 있습니다.');
        
        socket.leave('lobby');
        socket.join(roomId);
        socket.roomId = roomId;

        room.players.push({ 
            id: socket.id, name: nickname, avatar: avatar, hand: [], 
            unoDeclared: false, isBot: false, isHost: false, isReady: false 
        });
        
        socket.emit('joinSuccess', { isHost: false, roomName: room.name });
        io.to(roomId).emit('updatePlayers', room.players);
        broadcastRoomList(); 
    });

    socket.on('addBots', (count) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isHost) return; 
        
        const currentBots = room.players.filter(p => p.isBot).length;
        const botsToAdd = Math.min(count, 4 - currentBots); 

        for (let i = 0; i < botsToAdd; i++) {
            const randomAvatar = botAvatars[Math.floor(Math.random() * botAvatars.length)];
            room.players.push({ 
                id: `bot_${roomId}_${Math.random()}`, name: `봇 ${room.botCounter++}`, avatar: randomAvatar,
                hand: [], unoDeclared: false, isBot: true, isHost: false, isReady: true 
            });
        }
        io.to(roomId).emit('updatePlayers', room.players);
    });

    socket.on('kickPlayer', (targetId) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const host = room.players.find(p => p.id === socket.id);
        if (!host || !host.isHost || room.isGameRunning) return; 

        const targetIndex = room.players.findIndex(p => p.id === targetId);
        if (targetIndex !== -1) {
            const targetPlayer = room.players[targetIndex];
            room.players.splice(targetIndex, 1); 
            
            if (!targetPlayer.isBot) {
                io.to(targetPlayer.id).emit('kickedOut');
            }
            
            io.to(roomId).emit('updatePlayers', room.players);
            broadcastRoomList();
        }
    });

    socket.on('toggleReady', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.isHost && !room.isGameRunning) {
            player.isReady = !player.isReady;
            io.to(roomId).emit('updatePlayers', room.players);
        }
    });

    socket.on('declareUno', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const player = room.players.find(p => p.id === socket.id);
        if (player && room.isGameRunning) {
            if (player.hand.length <= 2) {
                player.unoDeclared = true;
                io.to(roomId).emit('systemMessage', `${player.name}: "우노!"`);
            } else {
                // 💡 3. 잘못된 우노 호출에 대한 벌점 처리
                if (room.deck.length > 0) player.hand.push(room.deck.pop());
                io.to(roomId).emit('systemMessage', `${player.name} 잘못된 우노 호출 (벌칙 1장)`);
                io.to(roomId).emit('penaltyApplied', { targetId: player.id, count: 1 }); // 💥 벌칙 이벤트 발생
                broadcastGameState(roomId); 
            }
        }
    });

    socket.on('catchUno', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const catcher = room.players.find(p => p.id === socket.id);
        if (!catcher || !room.isGameRunning) return;

        let caughtSomeone = false;
        room.players.forEach(p => {
            if (p.id !== catcher.id && p.hand.length === 1 && !p.unoDeclared) {
                if(room.deck.length > 0) p.hand.push(room.deck.pop());
                if(room.deck.length > 0) p.hand.push(room.deck.pop());
                p.unoDeclared = true;
                caughtSomeone = true;
                io.to(roomId).emit('systemMessage', `🚨 ${catcher.name}가 ${p.name}의 우노를 적발했습니다. (+2장)`);
                // 💥 상대방이 적발당했을 때도 벌칙 이벤트 전송
                io.to(roomId).emit('penaltyApplied', { targetId: p.id, count: 2 });
            }
        });

        if (caughtSomeone) broadcastGameState(roomId);
        else socket.emit('systemMessage', `적발 대상이 없습니다.`);
    });

    socket.on('startGame', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isHost || room.players.length < 2) return; 
        
        const allReady = room.players.every(p => p.isReady);
        if (!allReady) return socket.emit('systemMessage', '모든 참가자가 준비를 완료해야 합니다.');

        room.deck = shuffle(createDeck());
        room.players.forEach(p => { p.hand = room.deck.splice(0, 7); p.unoDeclared = false; });
        
        room.topCard = room.deck.pop();
        while(room.topCard.color === 'black') { 
            room.deck.push(room.topCard); 
            room.deck = shuffle(room.deck); 
            room.topCard = room.deck.pop(); 
        }
        
        room.currentTurnIndex = 0; room.direction = 1; room.penaltyStack = 0; room.turnLocked = false;
        room.isGameRunning = true; 
        
        io.to(roomId).emit('gameStarted');
        io.to(roomId).emit('systemMessage', `게임이 시작되었습니다.`);
        broadcastGameState(roomId);
        broadcastRoomList(); 

        if (room.players[room.currentTurnIndex].isBot) {
            setTimeout(() => { playBotTurn(roomId, room.players[room.currentTurnIndex]); }, 2200);
        }
    });

    socket.on('stopGame', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const player = room.players.find(p => p.id === socket.id);
        if (player && player.isHost && room.isGameRunning) {
            room.isGameRunning = false; room.penaltyStack = 0; room.turnLocked = false;
            room.players.forEach(p => { p.hand = []; p.unoDeclared = false; p.isReady = p.isHost || p.isBot; }); 
            io.to(roomId).emit('gameStopped');
            io.to(roomId).emit('systemMessage', '방장이 게임을 중단했습니다.');
            io.to(roomId).emit('updatePlayers', room.players);
            broadcastRoomList(); 
        }
    });

    socket.on('returnToLobby', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const player = room.players.find(p => p.id === socket.id);
        if (player && player.isHost) {
            room.isGameRunning = false; room.penaltyStack = 0; room.turnLocked = false;
            room.players.forEach(p => { p.hand = []; p.unoDeclared = false; p.isReady = p.isHost || p.isBot; });
            io.to(roomId).emit('gameStopped');
            io.to(roomId).emit('updatePlayers', room.players);
            broadcastRoomList(); 
        }
    });

    socket.on('playCard', (data) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        if (room.turnLocked || room.players[room.currentTurnIndex].id !== socket.id || !room.isGameRunning) return;
        
        const player = room.players[room.currentTurnIndex];
        const playedCard = player.hand[data.cardIndex];

        if (room.penaltyStack > 0) {
            if (playedCard.value !== 'draw2' && playedCard.value !== 'wildDraw4') {
                return socket.emit('systemMessage', `❌ 앗! 폭탄이 돌고 있습니다! +2나 +4 카드로 방어해야 합니다.`);
            }
        }

        if (playedCard.color === 'black' || playedCard.color === room.topCard.color || playedCard.value === room.topCard.value) {
            executePlayCard(roomId, player, data.cardIndex, data.selectedColor);
        } else {
            socket.emit('systemMessage', `현재 규칙에 맞지 않는 카드입니다.`);
        }
    });

    socket.on('drawCard', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        if (room.turnLocked || room.players[room.currentTurnIndex].id !== socket.id || !room.isGameRunning) return;
        executeDrawCard(roomId, room.players[room.currentTurnIndex]);
    });

    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            const wasHost = room.players[playerIndex].isHost;
            room.players.splice(playerIndex, 1);
            const realPlayers = room.players.filter(p => !p.isBot);
            
            if (realPlayers.length === 0) {
                delete rooms[roomId]; 
                broadcastRoomList();
            } else {
                if (wasHost) { realPlayers[0].isHost = true; realPlayers[0].isReady = true; }
                if (room.isGameRunning) {
                    io.to(roomId).emit('systemMessage', `플레이어 이탈로 게임이 무효화되었습니다.`);
                    room.isGameRunning = false; room.penaltyStack = 0; room.turnLocked = false;
                    room.players.forEach(p => { p.hand = []; p.unoDeclared = false; p.isReady = p.isHost || p.isBot; });
                    io.to(roomId).emit('gameStopped');
                    io.to(roomId).emit('updatePlayers', room.players);
                    broadcastRoomList();
                } else {
                    io.to(roomId).emit('updatePlayers', room.players);
                    broadcastRoomList();
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`벌칙 이펙트 시스템 서버 실행 중. 포트: ${PORT}`));