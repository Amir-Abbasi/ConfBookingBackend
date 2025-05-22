const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Database setup
const db = new sqlite3.Database('./database.sqlite');

// Create tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      capacity INTEGER,
      floor INTEGER
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER,
      user_name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      purpose TEXT,
      FOREIGN KEY(room_id) REFERENCES rooms(id)
    )
  `);
  
  // Insert some sample rooms if none exist
  db.get("SELECT COUNT(*) as count FROM rooms", (err, row) => {
    if (row.count === 0) {
      db.run("INSERT INTO rooms (name, capacity, floor) VALUES ('Conference Room A', 10, 1)");
      db.run("INSERT INTO rooms (name, capacity, floor) VALUES ('Conference Room B', 6, 1)");
      db.run("INSERT INTO rooms (name, capacity, floor) VALUES ('Board Room', 20, 2)");
    }
  });
});

// API Routes

// Get all rooms
app.get('/api/rooms', (req, res) => {
  db.all("SELECT * FROM rooms", (err, rows) => {
    res.json(rows);
  });
});

// Get bookings for a room
app.get('/api/bookings/:roomId', (req, res) => {
  db.all(
    "SELECT * FROM bookings WHERE room_id = ?",
    [req.params.roomId],
    (err, rows) => {
      res.json(rows);
    }
  );
});

// Create a booking
app.post('/api/bookings', (req, res) => {
  const { room_id, user_name, start_time, end_time, purpose } = req.body;
  db.run(
    "INSERT INTO bookings (room_id, user_name, start_time, end_time, purpose) VALUES (?, ?, ?, ?, ?)",
    [room_id, user_name, start_time, end_time, purpose],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID });
    }
  );
});

// Delete a booking
app.delete('/api/bookings/:id', (req, res) => {
  db.run(
    "DELETE FROM bookings WHERE id = ?",
    [req.params.id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ deleted: this.changes });
    }
  );
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});