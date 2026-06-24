import express from "express";
import { auth, requireRole } from "../middleware/auth.js";
import SupportTicket from "../models/SupportTicket.js";

const router = express.Router();

// User: Create a ticket
router.post("/", auth, requireRole("customer"), async (req, res) => {
  try {
    const { subject, description, category } = req.body;
    const ticket = await SupportTicket.create({
      user: req.user.id,
      subject,
      description,
      category,
      messages: [{ sender: 'user', message: description }]
    });
    res.status(201).json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User: Get my tickets
router.get("/my-tickets", auth, requireRole("customer"), async (req, res) => {
  try {
    const tickets = await SupportTicket.find({ user: req.user.id }).sort({ updatedAt: -1 });
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User/Admin: Add message to ticket
router.post("/:id/messages", auth, async (req, res) => {
  try {
    const { message } = req.body;
    const sender = req.user.role === 'admin' ? 'admin' : 'user';
    
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    
    // Check if user owns the ticket
    if (req.user.role !== 'admin' && ticket.user.toString() !== req.user.id) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    ticket.messages.push({ sender, message });
    if (sender === 'admin') ticket.status = 'In Progress';
    
    await ticket.save();
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User: Mark as resolved
router.put("/:id/resolve", auth, requireRole("customer"), async (req, res) => {
  try {
    const ticket = await SupportTicket.findOne({ _id: req.params.id, user: req.user.id });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    
    ticket.status = 'Resolved';
    await ticket.save();
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Get all tickets
router.get("/admin/all", auth, requireRole("admin"), async (req, res) => {
  try {
    const tickets = await SupportTicket.find().populate('user', 'name email phone').sort({ updatedAt: -1 });
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Update status
router.put("/admin/:id/status", auth, requireRole("admin"), async (req, res) => {
  try {
    const { status } = req.body;
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    
    ticket.status = status;
    await ticket.save();
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;