const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { isAfter, isBefore, parseISO } = require('date-fns');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// JWT Secret Key
const JWT_SECRET = 'your-secret-key'; // In production, use environment variable

// Database setup
const db = new sqlite3.Database('./database.sqlite');

// Create tables
db.serialize(() => {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      is_admin BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create default admin user if none exists
  db.get("SELECT COUNT(*) as count FROM users WHERE is_admin = 1", (err, row) => {
    if (row.count === 0) {
      const defaultAdmin = {
        username: 'admin',
        password: bcrypt.hashSync('admin123', 10),
        email: 'admin@example.com',
        is_admin: 1
      };
      
      db.run(
        "INSERT INTO users (username, password, email, is_admin) VALUES (?, ?, ?, ?)",
        [defaultAdmin.username, defaultAdmin.password, defaultAdmin.email, defaultAdmin.is_admin]
      );
    }
  });

  // First, check if features column exists in rooms table
  db.get("PRAGMA table_info(rooms)", (err, rows) => {
    if (err) {
      console.error('Error checking table structure:', err);
      return;
    }
    
    // Create or alter rooms table
    db.run(`
      CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        capacity INTEGER,
        floor INTEGER,
        features TEXT
      )
    `);

    // Add features column if it doesn't exist
    db.run(`
      ALTER TABLE rooms ADD COLUMN features TEXT DEFAULT '[]'
    `, (err) => {
      if (err && !err.message.includes('duplicate column')) {
        console.error('Error adding features column:', err);
      }
    });
  });
  
  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER,
      user_name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      purpose TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(room_id) REFERENCES rooms(id)
    )
  `);
  
  // Insert sample rooms if none exist
  db.get("SELECT COUNT(*) as count FROM rooms", (err, row) => {
    if (row.count === 0) {
      const sampleRooms = [
        ['Conference Room A', 10, 1, JSON.stringify(['Projector', 'Whiteboard', 'Video Conference'])],
        ['Conference Room B', 6, 1, JSON.stringify(['Whiteboard', 'TV Screen'])],
        ['Board Room', 20, 2, JSON.stringify(['Projector', 'Video Conference', 'Coffee Machine'])],
        ['Meeting Room 1', 4, 1, JSON.stringify(['TV Screen'])],
        ['Meeting Room 2', 4, 2, JSON.stringify(['Whiteboard'])]
      ];
      
      sampleRooms.forEach(room => {
        db.run(
          "INSERT INTO rooms (name, capacity, floor, features) VALUES (?, ?, ?, ?)",
          room
        );
      });
    }
  });
});

// Middleware for checking if room exists
const checkRoomExists = (req, res, next) => {
  const roomId = req.params.roomId || req.body.room_id;
  db.get("SELECT * FROM rooms WHERE id = ?", [roomId], (err, room) => {
    if (err) {
      return res.status(500).json({ error: "Database error" });
    }
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    req.room = room;
    next();
  });
};

// Validation middleware for booking
const validateBooking = (req, res, next) => {
  const { user_name, start_time, end_time, purpose } = req.body;

  if (!user_name || !start_time || !end_time || !purpose) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const startDate = parseISO(start_time);
  const endDate = parseISO(end_time);
  const now = new Date();

  if (isBefore(startDate, now)) {
    return res.status(400).json({ error: "Cannot book in the past" });
  }

  if (!isAfter(endDate, startDate)) {
    return res.status(400).json({ error: "End time must be after start time" });
  }

  next();
};

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: "Access token required" });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Invalid or expired token" });
    }
    req.user = user;
    next();
  });
};

// Admin middleware
const requireAdmin = (req, res, next) => {
  if (!req.user.is_admin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};

// Auth Routes
// Register new user (admin only)
app.post('/api/auth/register', authenticateToken, requireAdmin, async (req, res) => {
  const { username, password, email, is_admin } = req.body;

  if (!username || !password || !email) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    db.run(
      "INSERT INTO users (username, password, email, is_admin) VALUES (?, ?, ?, ?)",
      [username, hashedPassword, email, is_admin ? 1 : 0],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: "Username or email already exists" });
          }
          return res.status(500).json({ error: "Failed to create user" });
        }
        res.status(201).json({ message: "User created successfully" });
      }
    );
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  db.get(
    "SELECT * FROM users WHERE username = ?",
    [username],
    async (err, user) => {
      if (err) {
        return res.status(500).json({ error: "Database error" });
      }
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const token = jwt.sign(
        { id: user.id, username: user.username, is_admin: user.is_admin },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          is_admin: user.is_admin
        }
      });
    }
  );
});

// User management routes (admin only)
app.get('/api/users', authenticateToken, requireAdmin, (req, res) => {
  db.all("SELECT id, username, email, is_admin, created_at FROM users", (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch users" });
    }
    res.json(rows);
  });
});

app.delete('/api/users/:userId', authenticateToken, requireAdmin, (req, res) => {
  if (req.user.id === parseInt(req.params.userId)) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }

  db.run(
    "DELETE FROM users WHERE id = ?",
    [req.params.userId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: "Failed to delete user" });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ message: "User deleted successfully" });
    }
  );
});

// Protect existing routes with authentication
app.use('/api/rooms', authenticateToken);
app.use('/api/bookings', authenticateToken);

// API Routes

// Get all rooms
app.get('/api/rooms', (req, res) => {
  db.all("SELECT * FROM rooms", (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch rooms" });
    }
    rows.forEach(room => {
      try {
        room.features = JSON.parse(room.features);
      } catch (e) {
        room.features = [];
      }
    });
    res.json(rows);
  });
});

// Get room details
app.get('/api/rooms/:roomId', checkRoomExists, (req, res) => {
  res.json(req.room);
});

// Get all bookings (admin only)
app.get('/api/bookings', authenticateToken, requireAdmin, (req, res) => {
  db.all(
    `SELECT bookings.*, rooms.name as room_name 
     FROM bookings 
     LEFT JOIN rooms ON bookings.room_id = rooms.id 
     ORDER BY bookings.start_time DESC`,
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: "Failed to fetch bookings" });
      }
      res.json(rows);
    }
  );
});

// Get bookings for a room
app.get('/api/bookings/:roomId', checkRoomExists, (req, res) => {
  const { start_date, end_date } = req.query;
  let query = "SELECT * FROM bookings WHERE room_id = ?";
  const params = [req.params.roomId];

  if (start_date && end_date) {
    query += " AND start_time >= ? AND end_time <= ?";
    params.push(start_date, end_date);
  }

  query += " ORDER BY start_time ASC";

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch bookings" });
    }
    res.json(rows);
  });
});

// Check room availability
app.get('/api/rooms/:roomId/availability', checkRoomExists, (req, res) => {
  const { start_time, end_time } = req.query;
  
  if (!start_time || !end_time) {
    return res.status(400).json({ error: "Start time and end time are required" });
  }

  db.all(
    `SELECT * FROM bookings 
     WHERE room_id = ? 
     AND ((start_time <= ? AND end_time > ?) OR (start_time < ? AND end_time >= ?))`,
    [req.params.roomId, end_time, start_time, end_time, start_time],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: "Failed to check availability" });
      }
      res.json({ available: rows.length === 0, conflicting_bookings: rows });
    }
  );
});

// Create a booking
app.post('/api/bookings', checkRoomExists, validateBooking, (req, res) => {
  const { room_id, user_name, start_time, end_time, purpose } = req.body;

  // Check for conflicting bookings
  db.all(
    `SELECT * FROM bookings 
     WHERE room_id = ? 
     AND ((start_time <= ? AND end_time > ?) OR (start_time < ? AND end_time >= ?))`,
    [room_id, end_time, start_time, end_time, start_time],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: "Failed to check availability" });
      }
      
      if (rows.length > 0) {
        return res.status(409).json({ 
          error: "Time slot is already booked",
          conflicting_bookings: rows
        });
      }

      // Create the booking
      db.run(
        `INSERT INTO bookings (room_id, user_name, start_time, end_time, purpose)
         VALUES (?, ?, ?, ?, ?)`,
        [room_id, user_name, start_time, end_time, purpose],
        function(err) {
          if (err) {
            return res.status(500).json({ error: "Failed to create booking" });
          }
          res.status(201).json({ 
            id: this.lastID,
            message: "Booking created successfully" 
          });
        }
      );
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
        return res.status(500).json({ error: "Failed to delete booking" });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Booking not found" });
      }
      res.json({ message: "Booking deleted successfully" });
    }
  );
});

// Admin Routes for Room Management
app.post('/api/rooms', authenticateToken, requireAdmin, (req, res) => {
  const { name, capacity, floor, features } = req.body;

  if (!name || !capacity || !floor) {
    return res.status(400).json({ error: "Name, capacity, and floor are required" });
  }

  db.run(
    "INSERT INTO rooms (name, capacity, floor, features) VALUES (?, ?, ?, ?)",
    [name, capacity, floor, JSON.stringify(features || [])],
    function(err) {
      if (err) {
        return res.status(500).json({ error: "Failed to create room" });
      }
      res.status(201).json({ 
        id: this.lastID,
        message: "Room created successfully" 
      });
    }
  );
});

app.put('/api/rooms/:roomId', authenticateToken, requireAdmin, checkRoomExists, (req, res) => {
  const { name, capacity, floor, features } = req.body;
  console.log('Updating room:', req.params.roomId);
  console.log('Request body:', req.body);

  if (!name || !capacity || !floor) {
    return res.status(400).json({ error: "Name, capacity, and floor are required" });
  }

  try {
    const featuresJson = JSON.stringify(features || []);
    console.log('Features to update:', featuresJson);

    db.run(
      "UPDATE rooms SET name = ?, capacity = ?, floor = ?, features = ? WHERE id = ?",
      [name, capacity, floor, featuresJson, req.params.roomId],
      function(err) {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: "Failed to update room", details: err.message });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: "Room not found or no changes made" });
        }
        res.json({ 
          message: "Room updated successfully",
          changes: this.changes
        });
      }
    );
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: "Server error while updating room", details: err.message });
  }
});

app.delete('/api/rooms/:roomId', authenticateToken, requireAdmin, checkRoomExists, (req, res) => {
  db.run(
    "DELETE FROM rooms WHERE id = ?",
    [req.params.roomId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: "Failed to delete room" });
      }
      res.json({ message: "Room deleted successfully" });
    }
  );
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});