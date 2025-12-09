import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Asana configuration
const ASANA_TOKEN =
  '2/1212353370344534/1212340334177314:423f18d3f0b9a38f0e75513a31350873';
const ASANA_WORKSPACE = '1211014974336131';
const ASANA_PROJECT = '1212353369442239';

// Track conversations that have already submitted
const submittedConversations = new Set();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

/*
  This object defines the canvas that will display when your app initializes.
  It includes a button to create an Asana task for the contact.
  
  More information on these can be found in the reference docs.
  Canvas docs: https://developers.intercom.com/docs/references/canvas-kit/responseobjects/canvas/
  Components docs: https://developers.intercom.com/docs/references/canvas-kit/interactivecomponents/button/
*/
const initialCanvas = {
  canvas: {
    content: {
      components: [
        {
          type: 'text',
          id: 'header',
          text: 'Create Asana Task for Contact',
          align: 'center',
          style: 'header',
        },
        {
          type: 'button',
          label: 'Create Asana Task',
          style: 'primary',
          id: 'submit_button',
          action: {
            type: 'submit',
          },
        },
      ],
    },
  },
};

// Root route - serves the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/*
  This is an endpoint that Intercom will POST HTTP request when a teammate inserts 
  the app into the inbox, or a new conversation is viewed.
*/
app.post('/initialize', (req, res) => {
  console.log('Initialize endpoint hit');
  res.send(initialCanvas);
});

/*
  When a submit action is taken in a canvas component, it will hit this endpoint.
  This endpoint creates an Asana task with the contact's name and prevents
  duplicate submissions per conversation.
*/
app.post('/submit', async (req, res) => {
  console.log('Submit endpoint hit with component_id:', req.body.component_id);
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  const conversationId = req.body.conversation_id;

  // Check if this conversation has already submitted
  if (submittedConversations.has(conversationId)) {
    const alreadySubmittedCanvas = {
      canvas: {
        content: {
          components: [
            {
              type: 'text',
              id: 'already_submitted',
              text: 'Task already created for this conversation',
              align: 'center',
              style: 'header',
            },
            {
              type: 'text',
              id: 'info',
              text: 'You can only create one Asana task per conversation.',
              align: 'center',
              style: 'paragraph',
            },
          ],
        },
      },
    };
    return res.send(alreadySubmittedCanvas);
  }

  if (req.body.component_id === 'submit_button') {
    try {
      // Extract contact name from Intercom data
      const contactName =
        req.body.user?.name || req.body.admin?.name || 'Unknown Contact';

      // Create Asana task
      const asanaResponse = await fetch('https://app.asana.com/api/1.0/tasks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: {
            workspace: ASANA_WORKSPACE,
            projects: [ASANA_PROJECT],
            name: contactName,
            notes: `Task created from Intercom conversation ${conversationId}`,
          },
        }),
      });

      const asanaData = await asanaResponse.json();

      if (asanaResponse.ok) {
        // Mark this conversation as submitted
        submittedConversations.add(conversationId);

        const successCanvas = {
          canvas: {
            content: {
              components: [
                {
                  type: 'text',
                  id: 'success',
                  text: '✓ Asana Task Created',
                  align: 'center',
                  style: 'header',
                },
                {
                  type: 'text',
                  id: 'task_name',
                  text: `Task: ${contactName}`,
                  align: 'center',
                  style: 'paragraph',
                },
                {
                  type: 'text',
                  id: 'task_id',
                  text: `Task ID: ${asanaData.data.gid}`,
                  align: 'center',
                  style: 'paragraph',
                },
              ],
            },
          },
        };
        res.send(successCanvas);
      } else {
        throw new Error(
          asanaData.errors?.[0]?.message || 'Failed to create Asana task'
        );
      }
    } catch (error) {
      console.error('Error creating Asana task:', error);

      const errorCanvas = {
        canvas: {
          content: {
            components: [
              {
                type: 'text',
                id: 'error',
                text: 'Error Creating Task',
                align: 'center',
                style: 'header',
              },
              {
                type: 'text',
                id: 'error_message',
                text: error.message || 'An unexpected error occurred',
                align: 'center',
                style: 'paragraph',
              },
            ],
          },
        },
      };
      res.send(errorCanvas);
    }
  } else {
    res.send(initialCanvas);
  }
});

const listener = app.listen(PORT, () => {
  console.log(`Your app is listening on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to view your app`);
});
