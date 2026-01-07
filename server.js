const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const questions = require('./data/questions.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Store active games
const games = new Map();

// Game class to manage each game session
class Game {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.players = new Map();
    this.started = false;
    this.gradeLevel = null;
    this.currentQuestion = null;
    this.questionIndex = 0;
    this.usedQuestions = new Set();
    this.questionAnswered = false;
    this.timerInterval = null;
    this.timeRemaining = 15;
    this.winner = null;
  }

  addPlayer(socketId, name) {
    this.players.set(socketId, {
      id: socketId,
      name: name,
      score: 0,
      isHost: socketId === this.hostId
    });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
  }

  getPlayerList() {
    return Array.from(this.players.values());
  }

  getRandomQuestion() {
    const gradeQuestions = questions[this.gradeLevel];
    if (!gradeQuestions) return null;

    // Flatten all strands into one array
    let allQuestions = [];
    for (const strand in gradeQuestions) {
      gradeQuestions[strand].forEach((q, idx) => {
        allQuestions.push({ ...q, strand, id: `${strand}-${idx}` });
      });
    }

    // Filter out used questions
    const availableQuestions = allQuestions.filter(q => !this.usedQuestions.has(q.id));

    if (availableQuestions.length === 0) {
      // Reset if all questions used
      this.usedQuestions.clear();
      return this.getRandomQuestion();
    }

    const randomIndex = Math.floor(Math.random() * availableQuestions.length);
    const question = availableQuestions[randomIndex];
    this.usedQuestions.add(question.id);
    return question;
  }

  checkWinner() {
    for (const player of this.players.values()) {
      if (player.score >= 10) {
        return player;
      }
    }
    return null;
  }
}

// Validate game code (8 characters, alphanumeric)
function isValidCode(code) {
  return /^[A-Za-z0-9]{8}$/.test(code);
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Create a new game
  socket.on('createGame', (code) => {
    if (!isValidCode(code)) {
      socket.emit('error', 'Game code must be exactly 8 alphanumeric characters');
      return;
    }

    const upperCode = code.toUpperCase();

    if (games.has(upperCode)) {
      socket.emit('error', 'A game with this code already exists');
      return;
    }

    const game = new Game(upperCode, socket.id);
    games.set(upperCode, game);
    socket.join(upperCode);
    socket.gameCode = upperCode;

    socket.emit('gameCreated', { code: upperCode, isHost: true });
  });

  // Join an existing game
  socket.on('joinGame', (code) => {
    const upperCode = code.toUpperCase();
    const game = games.get(upperCode);

    if (!game) {
      socket.emit('error', 'Game not found');
      return;
    }

    if (game.started) {
      socket.emit('error', 'Game has already started');
      return;
    }

    socket.join(upperCode);
    socket.gameCode = upperCode;

    socket.emit('gameJoined', { code: upperCode, isHost: false });
  });

  // Set player name
  socket.on('setName', (name) => {
    const game = games.get(socket.gameCode);
    if (!game) return;

    const trimmedName = name.trim().substring(0, 20);
    if (!trimmedName) {
      socket.emit('error', 'Please enter a valid name');
      return;
    }

    game.addPlayer(socket.id, trimmedName);
    io.to(socket.gameCode).emit('playerList', game.getPlayerList());
  });

  // Host selects grade level and starts game
  socket.on('startGame', (gradeLevel) => {
    const game = games.get(socket.gameCode);
    if (!game) return;

    if (socket.id !== game.hostId) {
      socket.emit('error', 'Only the host can start the game');
      return;
    }

    if (!['6th', '7th', '8th'].includes(gradeLevel)) {
      socket.emit('error', 'Invalid grade level');
      return;
    }

    game.gradeLevel = gradeLevel;
    game.started = true;

    io.to(socket.gameCode).emit('gameStarted', { gradeLevel });

    // Send first question after a short delay
    setTimeout(() => {
      sendNextQuestion(socket.gameCode);
    }, 1000);
  });

  // Player submits answer
  socket.on('submitAnswer', (answerIndex) => {
    const game = games.get(socket.gameCode);
    if (!game || !game.started || game.questionAnswered) return;

    const player = game.players.get(socket.id);
    if (!player) return;

    if (answerIndex === game.currentQuestion.correctIndex) {
      game.questionAnswered = true;
      clearInterval(game.timerInterval);

      player.score += 1;

      io.to(socket.gameCode).emit('questionResult', {
        winnerId: socket.id,
        winnerName: player.name,
        correctIndex: game.currentQuestion.correctIndex,
        scores: game.getPlayerList()
      });

      // Check if someone won the game
      const gameWinner = game.checkWinner();
      if (gameWinner) {
        game.winner = gameWinner;
        io.to(socket.gameCode).emit('gameOver', {
          winner: gameWinner,
          scores: game.getPlayerList()
        });
      } else {
        // Next question after 3 seconds
        setTimeout(() => {
          sendNextQuestion(socket.gameCode);
        }, 3000);
      }
    }
  });

  // Chat message
  socket.on('chatMessage', (message) => {
    const game = games.get(socket.gameCode);
    if (!game) return;

    const player = game.players.get(socket.id);
    if (!player) return;

    const trimmedMessage = message.trim().substring(0, 200);
    if (!trimmedMessage) return;

    io.to(socket.gameCode).emit('chatMessage', {
      playerId: socket.id,
      playerName: player.name,
      message: trimmedMessage,
      timestamp: Date.now()
    });
  });

  // Play again
  socket.on('playAgain', () => {
    const game = games.get(socket.gameCode);
    if (!game) return;

    if (socket.id !== game.hostId) {
      socket.emit('error', 'Only the host can restart the game');
      return;
    }

    // Reset game state
    game.started = false;
    game.currentQuestion = null;
    game.questionIndex = 0;
    game.usedQuestions.clear();
    game.questionAnswered = false;
    game.winner = null;
    clearInterval(game.timerInterval);

    // Reset player scores
    for (const player of game.players.values()) {
      player.score = 0;
    }

    io.to(socket.gameCode).emit('gameReset', game.getPlayerList());
  });

  // Leave game
  socket.on('leaveGame', () => {
    handleDisconnect(socket);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });

  function handleDisconnect(socket) {
    const game = games.get(socket.gameCode);
    if (!game) return;

    game.removePlayer(socket.id);
    socket.leave(socket.gameCode);

    // If host leaves, end the game
    if (socket.id === game.hostId) {
      clearInterval(game.timerInterval);
      io.to(socket.gameCode).emit('hostLeft');
      games.delete(socket.gameCode);
    } else {
      io.to(socket.gameCode).emit('playerList', game.getPlayerList());
    }

    socket.gameCode = null;
  }
});

function shuffleAnswers(answers, correctIndex) {
  // Create array of {answer, isCorrect} objects
  const answerObjs = answers.map((answer, idx) => ({
    answer,
    isCorrect: idx === correctIndex
  }));

  // Fisher-Yates shuffle
  for (let i = answerObjs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [answerObjs[i], answerObjs[j]] = [answerObjs[j], answerObjs[i]];
  }

  // Extract shuffled answers and find new correct index
  const shuffledAnswers = answerObjs.map(obj => obj.answer);
  const newCorrectIndex = answerObjs.findIndex(obj => obj.isCorrect);

  return { shuffledAnswers, newCorrectIndex };
}

function sendNextQuestion(gameCode) {
  const game = games.get(gameCode);
  if (!game || !game.started || game.winner) return;

  game.questionAnswered = false;
  game.currentQuestion = game.getRandomQuestion();
  game.questionIndex++;
  game.timeRemaining = 15;

  // Shuffle answers and update correct index
  const { shuffledAnswers, newCorrectIndex } = shuffleAnswers(
    game.currentQuestion.answers,
    game.currentQuestion.correctIndex
  );
  game.currentQuestion.answers = shuffledAnswers;
  game.currentQuestion.correctIndex = newCorrectIndex;

  io.to(gameCode).emit('newQuestion', {
    question: game.currentQuestion.question,
    answers: game.currentQuestion.answers,
    strand: game.currentQuestion.strand,
    questionNumber: game.questionIndex
  });

  // Start countdown timer
  clearInterval(game.timerInterval);
  game.timerInterval = setInterval(() => {
    game.timeRemaining--;
    io.to(gameCode).emit('timerUpdate', game.timeRemaining);

    if (game.timeRemaining <= 0) {
      clearInterval(game.timerInterval);

      if (!game.questionAnswered) {
        game.questionAnswered = true;
        io.to(gameCode).emit('timeUp', {
          correctIndex: game.currentQuestion.correctIndex,
          scores: game.getPlayerList()
        });

        // Next question after 3 seconds
        setTimeout(() => {
          sendNextQuestion(gameCode);
        }, 3000);
      }
    }
  }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Trivia game server running on http://localhost:${PORT}`);
});
